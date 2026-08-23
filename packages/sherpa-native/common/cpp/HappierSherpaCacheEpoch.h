#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>

namespace happier_sherpa {

/**
 * The invalidation counters a per-assets-directory engine cache captures before
 * it builds an engine and re-checks before publishing it.
 *
 * Building an engine loads a model and takes seconds, so it cannot happen under
 * the cache lock -- that would block every invalidation for the whole load. The
 * unlocked window leaves an ordering the caches cannot survive on removals
 * alone: a pack invalidation lands while a creation is still running, finds
 * nothing cached because nothing has been published yet, reports the directory
 * clear to the installer that awaited it, and is then overtaken by the
 * publication of an engine built from the bytes it just retired. Removing
 * already-published entries cannot close that window. A counter can, because it
 * advances whether or not anything was cached.
 *
 * `key` advances when one assets directory is retired, so a creation for a
 * different pack is never refused by an unrelated invalidation -- that would
 * fail a start the user did nothing to invalidate. `module` advances on
 * teardown, which must also refuse a creation for a directory no
 * single-directory invalidation ever named, or the process-static caches are
 * repopulated after the module that owned them is gone.
 */
struct CacheEpoch {
  std::uint64_t key = 0;
  std::uint64_t module = 0;
};

/**
 * Not internally synchronized on purpose: the owning cache already serializes
 * capture, advance, and re-check on its own mutex, and a second lock here would
 * only add a way for the two to disagree about the same instant.
 *
 * The key set is retained for the life of the process. That is bounded by the
 * installed model-pack directories a single run ever retires -- a handful --
 * because the keys are the stable paths the installer promotes bytes into, not
 * per-job or per-request identities. Pruning would have to prove no creation
 * captured the key it drops, which is the very race these counters exist for.
 */
class CacheEpochs {
 public:
  /** The epoch a creation about to start for `key` must still be at to publish. */
  CacheEpoch capture(const std::string &key) const {
    const auto it = keyEpochs_.find(key);
    return CacheEpoch{it == keyEpochs_.end() ? 0 : it->second, moduleEpoch_};
  }

  bool isCurrent(const std::string &key, const CacheEpoch &captured) const {
    const CacheEpoch now = capture(key);
    return now.key == captured.key && now.module == captured.module;
  }

  /** Retire one assets directory, whether or not it had anything cached. */
  void advanceKey(const std::string &key) { ++keyEpochs_[key]; }

  /** Retire every assets directory, including ones this cache never held. */
  void advanceModule() { ++moduleEpoch_; }

 private:
  std::unordered_map<std::string, std::uint64_t> keyEpochs_;
  std::uint64_t moduleEpoch_ = 0;
};

}  // namespace happier_sherpa
