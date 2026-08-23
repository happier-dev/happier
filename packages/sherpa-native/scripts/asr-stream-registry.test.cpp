#include "../common/cpp/HappierSherpaAsrStreamRegistry.h"

#include <atomic>
#include <cassert>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {

// Stand-ins for the opaque sherpa-onnx handles. The registry never dereferences
// them; these only record whether the platform deleter has run, which is the
// property every ownership assertion below turns on.
struct FakeRecognizer {
  std::atomic<bool> *destroyed;
};
struct FakeStream {
  std::atomic<bool> *destroyed;
  std::atomic<int> decoded{0};
};

using Registry = happier_sherpa::AsrStreamRegistry<FakeRecognizer, FakeStream>;
// The iOS xcframework hands back const-qualified handles; instantiate that form
// too so the shared owner stays usable from both platforms.
using ConstQualifiedRegistry = happier_sherpa::AsrStreamRegistry<const FakeRecognizer, const FakeStream>;

std::shared_ptr<FakeRecognizer> MakeRecognizer(std::atomic<bool> *destroyed) {
  return std::shared_ptr<FakeRecognizer>(new FakeRecognizer{destroyed}, [](FakeRecognizer *r) {
    r->destroyed->store(true);
    delete r;
  });
}

std::shared_ptr<FakeStream> MakeStream(std::atomic<bool> *destroyed) {
  auto *stream = new FakeStream();
  stream->destroyed = destroyed;
  return std::shared_ptr<FakeStream>(stream, [](FakeStream *s) {
    s->destroyed->store(true);
    delete s;
  });
}

void SpinUntil(const std::atomic<bool> &flag) {
  while (!flag.load()) {
    std::this_thread::yield();
  }
}

// A decode in flight must keep its stream and recognizer alive across a
// concurrent cancel, and must observe the cancel mark. This is the exact race
// the JNI push/cancel pair loses today.
void CancelDuringDecodeKeepsHandlesAlive() {
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> streamDestroyed{false};
  Registry registry;

  auto recognizer = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&recognizerDestroyed); });
  assert(registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&streamDestroyed)) != nullptr);

  std::atomic<bool> decoding{false};
  std::atomic<bool> cancelled{false};
  std::atomic<bool> observedCancel{false};
  std::atomic<bool> handlesAliveDuringCancel{false};

  std::thread decoder([&] {
    auto job = registry.findJob("job");
    assert(job != nullptr);
    decoding.store(true);
    SpinUntil(cancelled);
    // The registry has dropped its reference; this decode still owns both handles.
    handlesAliveDuringCancel.store(!streamDestroyed.load() && !recognizerDestroyed.load());
    job->stream()->decoded.fetch_add(1);
    observedCancel.store(job->cancelled());
  });

  std::thread canceller([&] {
    SpinUntil(decoding);
    assert(registry.cancelJob("job"));
    cancelled.store(true);
  });

  decoder.join();
  canceller.join();

  assert(handlesAliveDuringCancel.load());
  assert(observedCancel.load());
  assert(registry.activeJobCount() == 0);
  // The decode released last, so the stream is gone; the recognizer stays for reuse.
  assert(streamDestroyed.load());
  assert(!recognizerDestroyed.load());
}

// A tail decode must stay reachable. The finish path claims the job without
// removing it, so a stop pressed while the tail drains still cancels it and the
// handles still outlive the decode that owns them.
void FinishKeepsTheJobCancellableUntilItSettles() {
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> streamDestroyed{false};
  Registry registry;

  auto recognizer = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&recognizerDestroyed); });
  registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&streamDestroyed));

  {
    auto job = registry.beginFinish("job");
    assert(job != nullptr);
    assert(job->finishing());
    assert(!job->cancelled());
    // Still registered: this is what makes the tail decode reachable at all.
    assert(registry.activeJobCount() == 1);
    // A second finish must not drain the same stream concurrently.
    assert(registry.beginFinish("job") == nullptr);

    // The cancel a user's stop button issues while the tail drains.
    assert(registry.cancelJob("job"));
    assert(job->cancelled());
    assert(registry.activeJobCount() == 0);
    assert(!streamDestroyed.load());

    // The cancel already retired this identity, so settling removes nothing.
    assert(!registry.endFinish("job", job));
  }
  assert(streamDestroyed.load());
}

// Pack invalidation must reach a draining job too: a model whose bytes are about
// to be replaced cannot keep decoding just because a finish started first.
void ReleaseAssetsDirReachesADrainingJob() {
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> streamDestroyed{false};
  Registry registry;

  auto recognizer = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&recognizerDestroyed); });
  registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&streamDestroyed));

  auto job = registry.beginFinish("job");
  assert(job != nullptr);
  assert(registry.releaseAssetsDir("/packs/stt") == 1);
  assert(job->cancelled());
  assert(registry.recognizerForAssetsDir("/packs/stt") == nullptr);
  assert(!streamDestroyed.load());
  job.reset();
  assert(streamDestroyed.load());
}

// Settling a finish removes exactly the identity that drained, never a successor
// registered under the same id while the tail was still running.
void EndFinishRemovesOnlyTheSettledIdentity() {
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> firstStreamDestroyed{false};
  std::atomic<bool> secondStreamDestroyed{false};
  Registry registry;

  auto recognizer = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&recognizerDestroyed); });
  registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&firstStreamDestroyed));

  auto draining = registry.beginFinish("job");
  assert(draining != nullptr);

  // The session restarts under the same id before the tail settles.
  auto restarted = registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&secondStreamDestroyed));
  assert(restarted != nullptr);
  assert(restarted != draining);
  assert(draining->cancelled());

  assert(!registry.endFinish("job", draining));
  assert(registry.activeJobCount() == 1);
  assert(registry.findJob("job") == restarted);

  assert(registry.endFinish("job", restarted));
  assert(registry.activeJobCount() == 0);
}

// A recognizer retired by an invalidation must not be admitted afterwards: the
// creation path builds the recognizer and the stream outside the lock, so this
// is where an update that landed mid-creation has to win.
void AdmissionIsRefusedAfterItsRecognizerWasInvalidated() {
  // Declared before the registry so the flags outlive the deleters it runs.
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> freshDestroyed{false};
  std::atomic<bool> streamDestroyed{false};
  Registry registry;

  auto recognizer = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&recognizerDestroyed); });
  assert(recognizer != nullptr);

  // The pack is replaced while the caller is still creating its stream.
  assert(registry.releaseAssetsDir("/packs/stt") == 0);

  assert(registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&streamDestroyed)) == nullptr);
  assert(registry.activeJobCount() == 0);

  // The next recognizer built from the new bytes admits normally.
  auto fresh = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&freshDestroyed); });
  assert(fresh != recognizer);
  assert(registry.beginJob("job", "/packs/stt", fresh, MakeStream(&streamDestroyed)) != nullptr);
  assert(registry.activeJobCount() == 1);
}

// Re-registering a job id retires the previous stream instead of leaking it.
void BeginJobReplacesAnExistingJobId() {
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> firstDestroyed{false};
  std::atomic<bool> secondDestroyed{false};
  Registry registry;

  auto recognizer = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&recognizerDestroyed); });
  auto first = registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&firstDestroyed));
  assert(first != nullptr);

  auto second = registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&secondDestroyed));
  assert(second != nullptr);
  assert(second != first);
  assert(first->cancelled());
  assert(!firstDestroyed.load());  // still held by `first`
  first.reset();
  assert(firstDestroyed.load());
  assert(!secondDestroyed.load());
  assert(registry.activeJobCount() == 1);
}

// Pack invalidation: dropping an assets directory cancels exactly its jobs and
// releases its recognizer, without touching another pack's live work and without
// freeing anything a decode still holds.
void ReleaseAssetsDirCancelsOnlyThatPack() {
  std::atomic<bool> sttDestroyed{false};
  std::atomic<bool> otherDestroyed{false};
  std::atomic<bool> sttStreamDestroyed{false};
  std::atomic<bool> otherStreamDestroyed{false};
  Registry registry;

  auto stt = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&sttDestroyed); });
  auto other = registry.leaseOrCreateRecognizer("/packs/other", [&] { return MakeRecognizer(&otherDestroyed); });
  registry.beginJob("stt-job", "/packs/stt", stt, MakeStream(&sttStreamDestroyed));
  registry.beginJob("other-job", "/packs/other", other, MakeStream(&otherStreamDestroyed));
  assert(registry.cachedRecognizerCount() == 2);

  auto inFlight = registry.findJob("stt-job");
  assert(registry.releaseAssetsDir("/packs/stt") == 1);
  assert(registry.recognizerForAssetsDir("/packs/stt") == nullptr);
  assert(registry.recognizerForAssetsDir("/packs/other") != nullptr);
  assert(registry.activeJobCount() == 1);
  assert(inFlight->cancelled());
  assert(!sttStreamDestroyed.load());
  assert(!otherStreamDestroyed.load());

  inFlight.reset();
  assert(sttStreamDestroyed.load());
  stt.reset();
  assert(sttDestroyed.load());
  assert(!otherDestroyed.load());
}

// Module teardown: the registry outlives the platform module object, so it must
// be able to drop everything without knowing which assets directories it holds,
// and still without freeing a handle a decode owns.
void ReleaseAllDropsEveryPackAndJob() {
  std::atomic<bool> firstDestroyed{false};
  std::atomic<bool> secondDestroyed{false};
  std::atomic<bool> firstStreamDestroyed{false};
  std::atomic<bool> secondStreamDestroyed{false};
  Registry registry;

  auto first = registry.leaseOrCreateRecognizer("/packs/a", [&] { return MakeRecognizer(&firstDestroyed); });
  auto second = registry.leaseOrCreateRecognizer("/packs/b", [&] { return MakeRecognizer(&secondDestroyed); });
  registry.beginJob("a-job", "/packs/a", first, MakeStream(&firstStreamDestroyed));
  auto inFlight = registry.beginJob("b-job", "/packs/b", second, MakeStream(&secondStreamDestroyed));

  assert(registry.releaseAll() == 2);
  assert(registry.activeJobCount() == 0);
  assert(registry.cachedRecognizerCount() == 0);
  assert(firstStreamDestroyed.load());
  assert(inFlight->cancelled());
  assert(!secondStreamDestroyed.load());

  inFlight.reset();
  assert(secondStreamDestroyed.load());
  first.reset();
  second.reset();
  assert(firstDestroyed.load());
  assert(secondDestroyed.load());
}

// Same shape as the reproduction of the current JNI defect, at volume: every
// handle must end up destroyed exactly once and nothing may be touched after it.
void ConcurrentPushCancelFinishStress() {
  Registry registry;
  std::atomic<bool> recognizerDestroyed{false};
  auto recognizer = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&recognizerDestroyed); });

  constexpr int kRounds = 300;
  std::vector<std::unique_ptr<std::atomic<bool>>> destroyedFlags;
  destroyedFlags.reserve(kRounds);

  for (int round = 0; round < kRounds; round++) {
    destroyedFlags.push_back(std::make_unique<std::atomic<bool>>(false));
    const std::string jobId = "job-" + std::to_string(round);
    registry.beginJob(jobId, "/packs/stt", recognizer, MakeStream(destroyedFlags.back().get()));

    std::thread pusher([&, jobId] {
      auto job = registry.findJob(jobId);
      if (!job) return;
      for (int i = 0; i < 64 && !job->cancelled(); i++) {
        job->stream()->decoded.fetch_add(1);
      }
    });
    std::thread canceller([&, jobId] { registry.cancelJob(jobId); });
    std::thread finisher([&, jobId] {
      auto job = registry.beginFinish(jobId);
      if (!job) return;
      job->stream()->decoded.fetch_add(1);
      registry.endFinish(jobId, job);
    });

    pusher.join();
    canceller.join();
    finisher.join();
  }

  assert(registry.activeJobCount() == 0);
  for (const auto &flag : destroyedFlags) {
    assert(flag->load());
  }
  assert(!recognizerDestroyed.load());
  registry.releaseAssetsDir("/packs/stt");
  recognizer.reset();
  assert(recognizerDestroyed.load());
}


// The window the registry lock cannot cover: building a recognizer loads a model
// and takes seconds, so it runs unlocked. An invalidation landing inside that
// window finds nothing cached for the directory and reports it clear -- and must
// still stop the recognizer built from the retired bytes from being published.
// Publishing it would also defeat `beginJob`'s admission check, which asks only
// whether the recognizer is the one currently cached.
void ReleaseAssetsDirDuringCreationRefusesThePublication() {
  std::atomic<bool> staleDestroyed{false};
  std::atomic<bool> freshDestroyed{false};
  std::atomic<bool> streamDestroyed{false};
  Registry registry;

  auto published = registry.leaseOrCreateRecognizer("/packs/stt", [&] {
    // The pack is replaced while this recognizer is still loading. Cancelling
    // published jobs and dropping cached recognizers reaches neither: there are
    // none yet.
    assert(registry.releaseAssetsDir("/packs/stt") == 0);
    return MakeRecognizer(&staleDestroyed);
  });

  assert(published == nullptr);
  assert(registry.recognizerForAssetsDir("/packs/stt") == nullptr);
  assert(registry.cachedRecognizerCount() == 0);
  assert(staleDestroyed.load());

  // The invalidation is not sticky: a recognizer built from the new bytes
  // publishes and admits normally.
  auto fresh = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&freshDestroyed); });
  assert(fresh != nullptr);
  assert(registry.recognizerForAssetsDir("/packs/stt") == fresh);
  assert(registry.beginJob("job", "/packs/stt", fresh, MakeStream(&streamDestroyed)) != nullptr);
  assert(registry.activeJobCount() == 1);

  assert(registry.releaseAll() == 1);
}

// Teardown has the same window, and must reject a creation for a directory that
// no single-directory invalidation ever named -- otherwise the process-static
// registry is repopulated after the module that owned it is gone.
void ReleaseAllDuringCreationRefusesThePublication() {
  std::atomic<bool> staleDestroyed{false};
  std::atomic<bool> freshDestroyed{false};
  Registry registry;

  auto published = registry.leaseOrCreateRecognizer("/packs/stt", [&] {
    assert(registry.releaseAll() == 0);
    return MakeRecognizer(&staleDestroyed);
  });

  assert(published == nullptr);
  assert(registry.cachedRecognizerCount() == 0);
  assert(staleDestroyed.load());

  auto fresh = registry.leaseOrCreateRecognizer("/packs/stt", [&] { return MakeRecognizer(&freshDestroyed); });
  assert(fresh != nullptr);
  assert(registry.cachedRecognizerCount() == 1);
  registry.releaseAll();
}

// Retirement is scoped to the directory it named. A concurrent creation for a
// different pack must not be collateral damage: refusing it would fail a start
// the user did nothing to invalidate.
void ReleaseAssetsDirDuringCreationLeavesAnotherPackPublishable() {
  std::atomic<bool> otherDestroyed{false};
  Registry registry;

  auto other = registry.leaseOrCreateRecognizer("/packs/other", [&] {
    assert(registry.releaseAssetsDir("/packs/stt") == 0);
    return MakeRecognizer(&otherDestroyed);
  });

  assert(other != nullptr);
  assert(registry.recognizerForAssetsDir("/packs/other") == other);
  assert(registry.cachedRecognizerCount() == 1);
  registry.releaseAll();
}

}  // namespace

int main() {
  ConstQualifiedRegistry constQualified;
  assert(constQualified.activeJobCount() == 0);

  CancelDuringDecodeKeepsHandlesAlive();
  FinishKeepsTheJobCancellableUntilItSettles();
  ReleaseAssetsDirReachesADrainingJob();
  EndFinishRemovesOnlyTheSettledIdentity();
  AdmissionIsRefusedAfterItsRecognizerWasInvalidated();
  ReleaseAssetsDirDuringCreationRefusesThePublication();
  ReleaseAllDuringCreationRefusesThePublication();
  ReleaseAssetsDirDuringCreationLeavesAnotherPackPublishable();
  BeginJobReplacesAnExistingJobId();
  ReleaseAssetsDirCancelsOnlyThatPack();
  ReleaseAllDropsEveryPackAndJob();
  ConcurrentPushCancelFinishStress();
  return 0;
}
