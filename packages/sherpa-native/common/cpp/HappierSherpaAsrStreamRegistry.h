#pragma once

#include <atomic>
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
 * One live streaming-ASR job.
 *
 * The recognizer and the stream are held as `shared_ptr` with platform-supplied
 * deleters, so whoever decodes owns both handles for the whole decode. A cancel,
 * a finish, or a pack invalidation can only set the mark and drop *its* own
 * reference; the native handles are destroyed by whichever holder releases last,
 * never underneath an in-flight decode.
 *
 * `cancelled()` is the streaming counterpart of `TtsJobState::cancelled`: read
 * between decode iterations, the way sherpa's generation callback reads the
 * offline TTS flag, so a cancel stops the work instead of only forgetting it.
 *
 * `finishing()` is the tail-decode state. A finishing job stays registered so a
 * cancel or a pack invalidation can still reach it, but it stops accepting new
 * audio: `SherpaOnnxOnlineStreamInputFinished` has already been called on the
 * stream, so a further push would feed a closed stream.
 *
 * The handle types are template parameters because the two vendored sherpa-onnx
 * headers disagree about const-qualification -- the Android C API declares
 * `SherpaOnnxOnlineStream *SherpaOnnxCreateOnlineStream(...)` while the iOS
 * xcframework declares `const SherpaOnnxOnlineStream *` -- and because keeping
 * sherpa types out of this header is what lets both platforms share one owner
 * and lets that owner be unit-tested on the host toolchain.
 */
template <typename Recognizer, typename Stream>
class AsrStreamJob {
 public:
  AsrStreamJob(std::string assetsDir,
               std::shared_ptr<Recognizer> recognizer,
               std::shared_ptr<Stream> stream)
      : assetsDir_(std::move(assetsDir)),
        recognizer_(std::move(recognizer)),
        stream_(std::move(stream)) {}

  AsrStreamJob(const AsrStreamJob &) = delete;
  AsrStreamJob &operator=(const AsrStreamJob &) = delete;

  const std::string &assetsDir() const noexcept { return assetsDir_; }
  Recognizer *recognizer() const noexcept { return recognizer_.get(); }
  Stream *stream() const noexcept { return stream_.get(); }

  void cancel() noexcept { cancelled_.store(true, std::memory_order_relaxed); }
  bool cancelled() const noexcept { return cancelled_.load(std::memory_order_relaxed); }

  /**
   * Claim the tail decode. Returns false when another caller already claimed it,
   * so one job is never drained twice concurrently.
   */
  bool markFinishing() noexcept { return !finishing_.exchange(true, std::memory_order_relaxed); }
  bool finishing() const noexcept { return finishing_.load(std::memory_order_relaxed); }

 private:
  const std::string assetsDir_;
  const std::shared_ptr<Recognizer> recognizer_;
  const std::shared_ptr<Stream> stream_;
  std::atomic<bool> cancelled_{false};
  std::atomic<bool> finishing_{false};
};

/**
 * The canonical owner of live streaming-ASR jobs and of the recognizers they
 * decode against, shared by the Android JNI layer and the iOS Objective-C++
 * layer so both platforms cancel and invalidate under one lifetime model.
 *
 * Callers never hold a raw handle across a lock release: `findJob`/`beginFinish`
 * hand back a `shared_ptr`, and the job stays valid for as long as that
 * reference lives. Removals move the released references out of the critical
 * section so a platform deleter never runs while the registry lock is held.
 *
 * Admission is decided against the recognizer cache under one lock, so a job
 * created from a recognizer that `releaseAssetsDir` retired in the meantime is
 * refused instead of quietly decoding the superseded model.
 *
 * Recognizers are cached per assets directory, which is the path the model-pack
 * installer promotes new bytes into. `releaseAssetsDir` is how pack
 * invalidation reaches them: it drops the cached recognizer and cancels exactly
 * the jobs decoding against that directory, so the next recognizer is built
 * from the new bytes while in-flight decodes wind down on the old ones.
 */
template <typename Recognizer, typename Stream>
class AsrStreamRegistry {
 public:
  using Job = AsrStreamJob<Recognizer, Stream>;
  using JobRef = std::shared_ptr<Job>;
  using RecognizerRef = std::shared_ptr<Recognizer>;
  using StreamRef = std::shared_ptr<Stream>;

  AsrStreamRegistry() = default;
  AsrStreamRegistry(const AsrStreamRegistry &) = delete;
  AsrStreamRegistry &operator=(const AsrStreamRegistry &) = delete;

  /** The recognizer cached for `assetsDir`, or nullptr when none is cached. */
  RecognizerRef recognizerForAssetsDir(const std::string &assetsDir) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = recognizersByAssetsDir_.find(assetsDir);
    return it == recognizersByAssetsDir_.end() ? RecognizerRef() : it->second;
  }

  /**
   * Lease the recognizer for `assetsDir`, calling `create` outside the lock when
   * nothing is cached, and return the recognizer callers must use.
   *
   * Creation loads a model and takes seconds, so it cannot run under the lock --
   * it would block every invalidation for the whole load. Owning the whole
   * find/create/publish sequence here rather than exposing a bare publish is
   * what keeps that unlocked window from becoming a second decision point: a
   * platform cannot forget to re-check whether the directory it started building
   * for is still current.
   *
   * An entry already cached wins, so a caller that lost a creation race discards
   * its own recognizer instead of replacing one other jobs are already decoding
   * against. Returns nullptr when `create` fails.
   */
  template <typename Create>
  RecognizerRef leaseOrCreateRecognizer(const std::string &assetsDir, Create &&create) {
    if (assetsDir.empty()) {
      return RecognizerRef();
    }
    CacheEpoch captured;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto cached = recognizersByAssetsDir_.find(assetsDir);
      if (cached != recognizersByAssetsDir_.end()) {
        return cached->second;
      }
      captured = epochs_.capture(assetsDir);
    }

    RecognizerRef created = create();
    if (!created) {
      return RecognizerRef();
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (!epochs_.isCurrent(assetsDir, captured)) {
      // A `releaseAssetsDir`/`releaseAll` overtook this creation. Publishing now
      // would put a recognizer built from the retired bytes back in front of
      // callers after the installer was told the directory was clear -- and
      // `beginJob`'s admission check, which asks only whether a recognizer is
      // the one currently cached, would then admit jobs onto it.
      return RecognizerRef();
    }
    auto existing = recognizersByAssetsDir_.find(assetsDir);
    if (existing != recognizersByAssetsDir_.end()) {
      return existing->second;
    }
    recognizersByAssetsDir_[assetsDir] = created;
    return created;
  }

  /**
   * Register the stream for `jobId`. A job already registered under that id is
   * cancelled and released, so a restarted job retires its predecessor instead
   * of leaking it.
   *
   * Admission is refused when `recognizer` is no longer the one cached for
   * `assetsDir`. Creating a recognizer and creating its stream cannot be done
   * under this lock -- both load a model and would block cancellation for
   * seconds -- so this is the point where the registry checks that a
   * `releaseAssetsDir` has not overtaken the creation it is admitting. Callers
   * treat a refusal as a failed creation and build again from the current bytes.
   */
  JobRef beginJob(const std::string &jobId,
                  const std::string &assetsDir,
                  RecognizerRef recognizer,
                  StreamRef stream) {
    if (jobId.empty() || !recognizer || !stream) {
      return JobRef();
    }

    auto job = std::make_shared<Job>(assetsDir, recognizer, std::move(stream));
    JobRef replaced;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto cached = recognizersByAssetsDir_.find(assetsDir);
      if (cached == recognizersByAssetsDir_.end() || cached->second != recognizer) {
        return JobRef();
      }

      auto existing = jobsById_.find(jobId);
      if (existing != jobsById_.end()) {
        existing->second->cancel();
        replaced = std::move(existing->second);
        jobsById_.erase(existing);
      }
      jobsById_[jobId] = job;
    }
    return job;
  }

  /** The job for `jobId`, kept alive for as long as the caller holds it. */
  JobRef findJob(const std::string &jobId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = jobsById_.find(jobId);
    return it == jobsById_.end() ? JobRef() : it->second;
  }

  /**
   * Claim the tail decode for `jobId` and hand the caller a reference that keeps
   * the handles alive for it. The job stays registered and is marked finishing,
   * so a cancel or a pack invalidation arriving while the tail drains still
   * finds it and still stops the decode -- the reason this is not a removal.
   * Returns nullptr when no such job is registered or when another caller is
   * already draining it.
   */
  JobRef beginFinish(const std::string &jobId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = jobsById_.find(jobId);
    if (it == jobsById_.end() || !it->second->markFinishing()) {
      return JobRef();
    }
    return it->second;
  }

  /**
   * Retire the exact job `beginFinish` handed out, once its tail decode has
   * settled. A registration that is no longer that job -- because the id was
   * restarted, cancelled, or invalidated meanwhile -- is left alone, so this
   * never removes a successor. Returns whether that identity was still
   * registered.
   */
  bool endFinish(const std::string &jobId, const JobRef &job) {
    JobRef retired;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto it = jobsById_.find(jobId);
      if (it == jobsById_.end() || it->second != job) {
        return false;
      }
      retired = std::move(it->second);
      jobsById_.erase(it);
    }
    return true;
  }

  /**
   * Mark the job for `jobId` cancelled and drop the registry's reference.
   * Returns whether a job was registered.
   */
  bool cancelJob(const std::string &jobId) {
    JobRef cancelled;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      auto it = jobsById_.find(jobId);
      if (it == jobsById_.end()) {
        return false;
      }
      it->second->cancel();
      cancelled = std::move(it->second);
      jobsById_.erase(it);
    }
    return true;
  }

  /**
   * Drop the recognizer cached for `assetsDir` and cancel every job decoding
   * against it. Returns the number of jobs cancelled.
   */
  std::size_t releaseAssetsDir(const std::string &assetsDir) {
    std::vector<JobRef> cancelled;
    RecognizerRef released;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      // Advanced regardless of what is cached: a recognizer for this directory
      // that is still being built has nothing to remove yet, and is exactly the
      // one that must not be published after this returns.
      epochs_.advanceKey(assetsDir);
      auto recognizer = recognizersByAssetsDir_.find(assetsDir);
      if (recognizer != recognizersByAssetsDir_.end()) {
        released = std::move(recognizer->second);
        recognizersByAssetsDir_.erase(recognizer);
      }

      for (auto it = jobsById_.begin(); it != jobsById_.end();) {
        if (it->second->assetsDir() != assetsDir) {
          ++it;
          continue;
        }
        it->second->cancel();
        cancelled.push_back(std::move(it->second));
        it = jobsById_.erase(it);
      }
    }
    return cancelled.size();
  }

  /**
   * Drop every cached recognizer and cancel every job. This is the teardown
   * path: the registry outlives the platform module object, so a module being
   * destroyed releases its native handles here rather than leaving them held
   * for the life of the process. Returns the number of jobs cancelled.
   */
  std::size_t releaseAll() {
    std::vector<JobRef> cancelled;
    std::unordered_map<std::string, RecognizerRef> released;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      epochs_.advanceModule();
      released.swap(recognizersByAssetsDir_);
      cancelled.reserve(jobsById_.size());
      for (auto &entry : jobsById_) {
        entry.second->cancel();
        cancelled.push_back(std::move(entry.second));
      }
      jobsById_.clear();
    }
    return cancelled.size();
  }

  std::size_t activeJobCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return jobsById_.size();
  }

  std::size_t cachedRecognizerCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return recognizersByAssetsDir_.size();
  }

 private:
  mutable std::mutex mutex_;
  std::unordered_map<std::string, RecognizerRef> recognizersByAssetsDir_;
  std::unordered_map<std::string, JobRef> jobsById_;
  CacheEpochs epochs_;
};

}  // namespace happier_sherpa
