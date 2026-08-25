#include "../common/cpp/HappierSherpaOfflineTtsEngineCache.h"
#include "../common/cpp/HappierSherpaTtsJobRegistry.h"

#include <atomic>
#include <cassert>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {

// Stand-in for the platform offline-TTS engine. `destroyed` records that the
// sherpa handle was released exactly once, which is the property every ownership
// assertion below turns on; `jobs` is the real registry the platforms embed.
struct FakeEngine {
  explicit FakeEngine(std::atomic<int> *destroyCount) : destroyCount(destroyCount) {}
  ~FakeEngine() { destroyCount->fetch_add(1); }

  std::atomic<int> *destroyCount;
  happier_sherpa::TtsJobRegistry jobs;
};

using Cache = happier_sherpa::OfflineTtsEngineCache<FakeEngine>;

std::shared_ptr<FakeEngine> MakeEngine(std::atomic<int> *destroyCount) {
  return std::make_shared<FakeEngine>(destroyCount);
}

void SpinUntil(const std::atomic<bool> &flag) {
  while (!flag.load()) {
    std::this_thread::yield();
  }
}

// The update-versus-runtime race the installer loses today: a synthesis is
// already running when the pack is replaced. Retiring the engine must be
// immediate for the next caller, must stop the running job, and must not free
// the engine underneath it.
void ReleaseRetiresTheEngineWithoutFreeingARunningSynthesis() {
  std::atomic<int> destroyed{0};
  Cache cache;

  auto engine = cache.leaseOrCreate("/packs/kokoro", [&] { return MakeEngine(&destroyed); });
  assert(engine != nullptr);
  assert(cache.cachedEngineCount() == 1);

  // A synthesis in flight holds its own lease, exactly as the platform call does.
  auto lease = cache.find("/packs/kokoro");
  assert(lease == engine);
  bool alreadyCancelled = false;
  auto *state = lease->jobs.beginJob("job", &alreadyCancelled);
  assert(state != nullptr && !alreadyCancelled);

  auto retired = cache.release("/packs/kokoro");
  assert(retired == engine);
  assert(cache.cachedEngineCount() == 0);
  assert(cache.find("/packs/kokoro") == nullptr);
  // Retiring the entry is what the installer awaits; the handle is still alive
  // because the running synthesis owns it.
  assert(destroyed.load() == 0);

  assert(retired->jobs.retire() == 1);
  assert(state->cancelled.load());
  // Leasing the engine and registering a job on it are separate steps. A caller
  // that leased just before the invalidation must not be admitted just after it:
  // that synthesis would decode to completion against the superseded model, and
  // the installer has already been told the retirement is done.
  bool lateCancelled = false;
  assert(retired->jobs.beginJob("late", &lateCancelled) == nullptr);
  assert(lateCancelled);

  // The next caller builds from the new bytes rather than the retired engine.
  std::atomic<int> freshDestroyed{0};
  auto fresh = cache.leaseOrCreate("/packs/kokoro", [&] { return MakeEngine(&freshDestroyed); });
  assert(fresh != engine);
  assert(cache.cachedEngineCount() == 1);

  engine.reset();
  lease.reset();
  retired.reset();
  assert(destroyed.load() == 1);

  cache.releaseAll();
  fresh.reset();
  assert(freshDestroyed.load() == 1);
}

// Teardown must drop every cached engine, and each native handle must be
// destroyed exactly once no matter how many directories were cached.
void ReleaseAllDropsEveryEngineExactlyOnce() {
  std::atomic<int> firstDestroyed{0};
  std::atomic<int> secondDestroyed{0};
  Cache cache;

  cache.leaseOrCreate("/packs/a", [&] { return MakeEngine(&firstDestroyed); });
  auto inFlight = cache.leaseOrCreate("/packs/b", [&] { return MakeEngine(&secondDestroyed); });

  auto released = cache.releaseAll();
  assert(released.size() == 2);
  assert(cache.cachedEngineCount() == 0);
  // Teardown hands the engines to the caller so it can stop their work first;
  // nothing is freed while that handoff is still holding them.
  assert(firstDestroyed.load() == 0);
  assert(secondDestroyed.load() == 0);

  released.clear();
  // Nothing else held the first engine, so it died with the handoff. The second
  // is still leased by a synthesis in flight.
  assert(firstDestroyed.load() == 1);
  assert(secondDestroyed.load() == 0);

  inFlight.reset();
  assert(secondDestroyed.load() == 1);

  // A second teardown is a no-op rather than a double free.
  assert(cache.releaseAll().empty());
  assert(firstDestroyed.load() == 1);
  assert(secondDestroyed.load() == 1);
}

// A creation that loses the race keeps the engine other callers are already
// using, so one directory never ends up with two live engines.
void LeaseOrCreateKeepsTheEngineThatWonTheRace() {
  std::atomic<int> winnerDestroyed{0};
  std::atomic<int> loserDestroyed{0};
  Cache cache;

  std::shared_ptr<FakeEngine> winner;
  auto loser = cache.leaseOrCreate("/packs/kokoro", [&] {
    // A second caller misses the same empty cache and finishes first, which is
    // what two starts on a cold pack do.
    winner = cache.leaseOrCreate("/packs/kokoro", [&] { return MakeEngine(&winnerDestroyed); });
    return MakeEngine(&loserDestroyed);
  });

  assert(winner != nullptr);
  assert(loser == winner);
  assert(cache.cachedEngineCount() == 1);
  // The loser's engine was discarded on the spot rather than replacing the one
  // other synthesis calls already hold.
  assert(loserDestroyed.load() == 1);
  assert(winnerDestroyed.load() == 0);

  cache.releaseAll();
  winner.reset();
  loser.reset();
  assert(winnerDestroyed.load() == 1);
}

// Same shape at volume: a release racing a synthesis lease must never free an
// engine a caller still holds, and must never leak one either.
void ConcurrentLeaseAndReleaseStress() {
  constexpr int kRounds = 300;
  std::atomic<int> destroyed{0};
  Cache cache;

  for (int round = 0; round < kRounds; round++) {
    const std::string dir = "/packs/" + std::to_string(round);
    cache.leaseOrCreate(dir, [&] { return MakeEngine(&destroyed); });

    std::atomic<bool> leased{false};
    std::thread synthesizer([&, dir] {
      auto lease = cache.find(dir);
      // Published before the job is registered on purpose: this is what lets the
      // invalidator land on either side of the admission, which is the whole race.
      leased.store(true);
      if (!lease) return;
      bool alreadyCancelled = false;
      auto *state = lease->jobs.beginJob("job", &alreadyCancelled);
      // Either the job was admitted and then cancelled, or the retirement won and
      // refused it. A third outcome -- admitted after the retirement and never
      // cancelled -- would decode against the superseded model, and would hang
      // this loop rather than quietly passing.
      assert(state != nullptr || alreadyCancelled);
      while (state && !state->cancelled.load()) {
        std::this_thread::yield();
      }
      lease->jobs.finishJob("job");
    });
    std::thread invalidator([&, dir] {
      SpinUntil(leased);
      auto retired = cache.release(dir);
      if (retired) retired->jobs.retire();
    });

    synthesizer.join();
    invalidator.join();
    assert(cache.find(dir) == nullptr);
  }

  assert(cache.cachedEngineCount() == 0);
  assert(destroyed.load() == kRounds);
}


// The window the cache lock cannot cover: building an engine loads a model and
// takes seconds, so it runs unlocked. A pack invalidation landing inside that
// window finds nothing cached and reports the directory clear -- and must still
// stop the engine built from the bytes it retired from ever being published.
void ReleaseDuringCreationRefusesThePublication() {
  std::atomic<int> staleDestroyed{0};
  Cache cache;

  auto published = cache.leaseOrCreate("/packs/kokoro", [&] {
    // The installer retires the directory while this creation is still running.
    // Removing already-published entries reaches nothing: there is none yet.
    assert(cache.release("/packs/kokoro") == nullptr);
    return MakeEngine(&staleDestroyed);
  });

  assert(published == nullptr);
  assert(cache.cachedEngineCount() == 0);
  assert(cache.find("/packs/kokoro") == nullptr);
  // Discarded on the spot rather than left serving the superseded model.
  assert(staleDestroyed.load() == 1);

  // The invalidation is not sticky: a creation started after it publishes.
  std::atomic<int> freshDestroyed{0};
  auto fresh = cache.leaseOrCreate("/packs/kokoro", [&] { return MakeEngine(&freshDestroyed); });
  assert(fresh != nullptr);
  assert(cache.cachedEngineCount() == 1);
  assert(cache.find("/packs/kokoro") == fresh);

  cache.releaseAll();
  fresh.reset();
  assert(freshDestroyed.load() == 1);
}

// A caller may cancel its initialize request while it is waiting behind an
// active synthesis on the dedicated TTS worker. That request must be refused
// without retiring the pack: a pack release is for bytes being replaced or
// removed, and would incorrectly stop the unrelated synthesis that already owns
// the active engine.
void CancelledQueuedAdmissionLeavesActiveEngineAndJobAlive() {
  std::atomic<int> activeDestroyed{0};
  std::atomic<int> queuedCreateCalls{0};
  std::atomic<int> queuedDestroyed{0};
  Cache cache;

  auto active = cache.leaseOrCreate("/packs/kokoro", [&] { return MakeEngine(&activeDestroyed); });
  assert(active != nullptr);
  bool alreadyCancelled = false;
  auto *activeJob = active->jobs.beginJob("active", &alreadyCancelled);
  assert(activeJob != nullptr && !alreadyCancelled);

  constexpr const char *kCancelledAdmissionId = "cancelled-queued-initialize";
  assert(cache.admitInitialization("/packs/kokoro", kCancelledAdmissionId));
  assert(cache.cancelInitialization("/packs/kokoro", kCancelledAdmissionId));

  auto prevented = cache.leaseOrCreateInitialization(
      "/packs/kokoro",
      kCancelledAdmissionId,
      [&] {
        queuedCreateCalls.fetch_add(1);
        return MakeEngine(&queuedDestroyed);
      });

  // The cancelled request never gets to reuse or publish an engine, while the
  // active job and cache entry remain untouched.
  assert(prevented == nullptr);
  assert(queuedCreateCalls.load() == 0);
  assert(cache.find("/packs/kokoro") == active);
  assert(cache.cachedEngineCount() == 1);
  assert(!activeJob->cancelled.load());

  // Cancellation is specific to its immutable admission. A later request for
  // the same pack can still use the active engine normally.
  constexpr const char *kFreshAdmissionId = "fresh-initialize";
  assert(cache.admitInitialization("/packs/kokoro", kFreshAdmissionId));
  auto fresh = cache.leaseOrCreateInitialization(
      "/packs/kokoro",
      kFreshAdmissionId,
      [&] {
        queuedCreateCalls.fetch_add(1);
        return MakeEngine(&queuedDestroyed);
      });
  assert(fresh == active);
  assert(queuedCreateCalls.load() == 0);

  active->jobs.finishJob("active");
  cache.releaseAll();
  fresh.reset();
  active.reset();
  assert(activeDestroyed.load() == 1);
  assert(queuedDestroyed.load() == 0);
}

// Teardown has the same window, and must reject a creation for a directory that
// no single-directory invalidation ever named -- otherwise the process-static
// cache is repopulated after the module that owned it is gone.
void ReleaseAllDuringCreationRefusesThePublication() {
  std::atomic<int> staleDestroyed{0};
  Cache cache;

  auto published = cache.leaseOrCreate("/packs/kokoro", [&] {
    assert(cache.releaseAll().empty());
    return MakeEngine(&staleDestroyed);
  });

  assert(published == nullptr);
  assert(cache.cachedEngineCount() == 0);
  assert(staleDestroyed.load() == 1);

  std::atomic<int> freshDestroyed{0};
  auto fresh = cache.leaseOrCreate("/packs/kokoro", [&] { return MakeEngine(&freshDestroyed); });
  assert(fresh != nullptr);
  assert(cache.cachedEngineCount() == 1);

  cache.releaseAll();
  fresh.reset();
  assert(freshDestroyed.load() == 1);
}

// Retirement is scoped to the directory it named. A concurrent creation for a
// different pack must not be collateral damage: refusing it would fail a start
// the user did nothing to invalidate.
void ReleaseDuringCreationLeavesAnotherPackPublishable() {
  std::atomic<int> otherDestroyed{0};
  Cache cache;

  auto other = cache.leaseOrCreate("/packs/other", [&] {
    assert(cache.release("/packs/kokoro") == nullptr);
    return MakeEngine(&otherDestroyed);
  });

  assert(other != nullptr);
  assert(cache.find("/packs/other") == other);
  assert(cache.cachedEngineCount() == 1);

  cache.releaseAll();
  other.reset();
  assert(otherDestroyed.load() == 1);
}

}  // namespace

int main() {
  ReleaseRetiresTheEngineWithoutFreeingARunningSynthesis();
  ReleaseAllDropsEveryEngineExactlyOnce();
  LeaseOrCreateKeepsTheEngineThatWonTheRace();
  ReleaseDuringCreationRefusesThePublication();
  CancelledQueuedAdmissionLeavesActiveEngineAndJobAlive();
  ReleaseAllDuringCreationRefusesThePublication();
  ReleaseDuringCreationLeavesAnotherPackPublishable();
  ConcurrentLeaseAndReleaseStress();
  return 0;
}
