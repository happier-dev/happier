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

  auto recognizer = registry.rememberRecognizer("/packs/stt", MakeRecognizer(&recognizerDestroyed));
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

// Finishing takes the job out of the registry but leaves it owned by the caller,
// so a cancel that arrives afterwards cannot free the tail decode's stream.
void FinishTakesOwnershipFromTheRegistry() {
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> streamDestroyed{false};
  Registry registry;

  auto recognizer = registry.rememberRecognizer("/packs/stt", MakeRecognizer(&recognizerDestroyed));
  registry.beginJob("job", "/packs/stt", recognizer, MakeStream(&streamDestroyed));

  {
    auto job = registry.takeJob("job");
    assert(job != nullptr);
    assert(!job->cancelled());
    assert(registry.activeJobCount() == 0);
    assert(!registry.cancelJob("job"));
    assert(registry.takeJob("job") == nullptr);
    assert(!streamDestroyed.load());
  }
  assert(streamDestroyed.load());
}

// Re-registering a job id retires the previous stream instead of leaking it.
void BeginJobReplacesAnExistingJobId() {
  std::atomic<bool> recognizerDestroyed{false};
  std::atomic<bool> firstDestroyed{false};
  std::atomic<bool> secondDestroyed{false};
  Registry registry;

  auto recognizer = registry.rememberRecognizer("/packs/stt", MakeRecognizer(&recognizerDestroyed));
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

  auto stt = registry.rememberRecognizer("/packs/stt", MakeRecognizer(&sttDestroyed));
  auto other = registry.rememberRecognizer("/packs/other", MakeRecognizer(&otherDestroyed));
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

  auto first = registry.rememberRecognizer("/packs/a", MakeRecognizer(&firstDestroyed));
  auto second = registry.rememberRecognizer("/packs/b", MakeRecognizer(&secondDestroyed));
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
  auto recognizer = registry.rememberRecognizer("/packs/stt", MakeRecognizer(&recognizerDestroyed));

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
      auto job = registry.takeJob(jobId);
      if (job) job->stream()->decoded.fetch_add(1);
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

}  // namespace

int main() {
  ConstQualifiedRegistry constQualified;
  assert(constQualified.activeJobCount() == 0);

  CancelDuringDecodeKeepsHandlesAlive();
  FinishTakesOwnershipFromTheRegistry();
  BeginJobReplacesAnExistingJobId();
  ReleaseAssetsDirCancelsOnlyThatPack();
  ReleaseAllDropsEveryPackAndJob();
  ConcurrentPushCancelFinishStress();
  return 0;
}
