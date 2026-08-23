#pragma once

#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "HappierSherpaCacheEpoch.h"

namespace happier_sherpa {

/**
 * The canonical owner of offline-TTS engines, keyed by the assets directory the
 * model-pack installer promotes bytes into -- the same key the streaming ASR
 * recognizers use, so one invalidation reaches both engine kinds.
 *
 * Engines are held as `shared_ptr`, which is what makes a pack update safe: a
 * synthesis that is already running holds its own reference for the whole call,
 * so `release`/`releaseAll` can retire the cache entry immediately while the
 * engine itself is destroyed by whichever holder releases last. Without that
 * lease the installer would either have to leave a superseded engine serving the
 * predecessor model until the process restarts, or free it underneath a decode.
 *
 * The engine type is a template parameter for the same reason the ASR registry
 * is templated: it keeps sherpa types out of this header, so the ownership rules
 * can be exercised on the host toolchain under sanitizers.
 */
template <typename Engine>
class OfflineTtsEngineCache {
 public:
  using EngineRef = std::shared_ptr<Engine>;

  OfflineTtsEngineCache() = default;
  OfflineTtsEngineCache(const OfflineTtsEngineCache &) = delete;
  OfflineTtsEngineCache &operator=(const OfflineTtsEngineCache &) = delete;

  /** The engine cached for `assetsDir`, or nullptr when none is cached. */
  EngineRef find(const std::string &assetsDir) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = enginesByAssetsDir_.find(assetsDir);
    return it == enginesByAssetsDir_.end() ? EngineRef() : it->second;
  }

  /**
   * Lease the engine for `assetsDir`, calling `create` outside the lock when
   * nothing is cached, and return the engine callers must use.
   *
   * Creation loads a model and takes seconds, so it cannot run under the lock --
   * it would block every invalidation for the whole load. Owning the whole
   * find/create/publish sequence here rather than exposing a bare publish is
   * what keeps that unlocked window from becoming a second decision point: a
   * platform cannot forget to re-check whether the directory it started building
   * for is still current.
   *
   * An entry already cached wins, so a caller that lost a creation race discards
   * its own engine instead of replacing one other synthesis calls are using.
   * Returns nullptr when `create` fails.
   */
  template <typename Create>
  EngineRef leaseOrCreate(const std::string &assetsDir, Create &&create) {
    if (assetsDir.empty()) {
      return EngineRef();
    }
    CacheEpoch captured;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto cached = enginesByAssetsDir_.find(assetsDir);
      if (cached != enginesByAssetsDir_.end()) {
        return cached->second;
      }
      captured = epochs_.capture(assetsDir);
    }

    EngineRef created = create();
    if (!created) {
      return EngineRef();
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (!epochs_.isCurrent(assetsDir, captured)) {
      // A `release`/`releaseAll` overtook this creation. Publishing now would
      // put an engine built from the retired bytes back in front of callers
      // after the installer was told the directory was clear, so the candidate
      // is discarded here and the caller builds again from the current bytes.
      return EngineRef();
    }
    auto existing = enginesByAssetsDir_.find(assetsDir);
    if (existing != enginesByAssetsDir_.end()) {
      return existing->second;
    }
    enginesByAssetsDir_[assetsDir] = created;
    return created;
  }

  /**
   * Retire the engine cached for `assetsDir` and hand it back so the caller can
   * stop the work still running on it. Returns nullptr when nothing was cached.
   * The reference moves out of the critical section, so the engine's destructor
   * never runs while this lock is held.
   */
  EngineRef release(const std::string &assetsDir) {
    EngineRef released;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      // Advanced before the lookup and regardless of its outcome: an engine for
      // this directory that is still being built has nothing to remove yet, and
      // is exactly the one that must not be published after this returns.
      epochs_.advanceKey(assetsDir);
      auto it = enginesByAssetsDir_.find(assetsDir);
      if (it == enginesByAssetsDir_.end()) {
        return EngineRef();
      }
      released = std::move(it->second);
      enginesByAssetsDir_.erase(it);
    }
    return released;
  }

  /**
   * Retire every cached engine. This is the teardown path: the cache outlives
   * the platform module object, so a module being destroyed releases its native
   * engines here exactly once rather than leaking them for the life of the
   * process.
   */
  std::vector<EngineRef> releaseAll() {
    std::unordered_map<std::string, EngineRef> released;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      epochs_.advanceModule();
      released.swap(enginesByAssetsDir_);
    }

    std::vector<EngineRef> engines;
    engines.reserve(released.size());
    for (auto &entry : released) {
      engines.push_back(std::move(entry.second));
    }
    return engines;
  }

  /** Every currently cached engine, for work that must reach all of them. */
  std::vector<EngineRef> snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<EngineRef> engines;
    engines.reserve(enginesByAssetsDir_.size());
    for (const auto &entry : enginesByAssetsDir_) {
      engines.push_back(entry.second);
    }
    return engines;
  }

  std::size_t cachedEngineCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return enginesByAssetsDir_.size();
  }

 private:
  mutable std::mutex mutex_;
  std::unordered_map<std::string, EngineRef> enginesByAssetsDir_;
  CacheEpochs epochs_;
};

}  // namespace happier_sherpa
