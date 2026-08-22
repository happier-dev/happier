#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

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

 private:
  const std::string assetsDir_;
  const std::shared_ptr<Recognizer> recognizer_;
  const std::shared_ptr<Stream> stream_;
  std::atomic<bool> cancelled_{false};
};

/**
 * The canonical owner of live streaming-ASR jobs and of the recognizers they
 * decode against, shared by the Android JNI layer and the iOS Objective-C++
 * layer so both platforms cancel and invalidate under one lifetime model.
 *
 * Callers never hold a raw handle across a lock release: `findJob`/`takeJob`
 * hand back a `shared_ptr`, and the job stays valid for as long as that
 * reference lives. Removals move the released references out of the critical
 * section so a platform deleter never runs while the registry lock is held.
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
   * Cache `recognizer` for `assetsDir` and return the recognizer callers must
   * use. An entry already cached wins, so a caller that lost a creation race
   * discards its own recognizer instead of replacing a recognizer other jobs
   * are already decoding against.
   */
  RecognizerRef rememberRecognizer(const std::string &assetsDir, RecognizerRef recognizer) {
    if (assetsDir.empty() || !recognizer) {
      return RecognizerRef();
    }

    std::lock_guard<std::mutex> lock(mutex_);
    auto existing = recognizersByAssetsDir_.find(assetsDir);
    if (existing != recognizersByAssetsDir_.end()) {
      return existing->second;
    }
    recognizersByAssetsDir_[assetsDir] = recognizer;
    return recognizer;
  }

  /**
   * Register the stream for `jobId`. A job already registered under that id is
   * cancelled and released, so a restarted job retires its predecessor instead
   * of leaking it.
   */
  JobRef beginJob(const std::string &jobId,
                  const std::string &assetsDir,
                  RecognizerRef recognizer,
                  StreamRef stream) {
    if (jobId.empty() || !recognizer || !stream) {
      return JobRef();
    }

    auto job = std::make_shared<Job>(assetsDir, std::move(recognizer), std::move(stream));
    JobRef replaced;
    {
      std::lock_guard<std::mutex> lock(mutex_);
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
   * Remove the job for `jobId` and hand its ownership to the caller without
   * marking it cancelled. This is the finish path: the tail decode keeps the
   * handles alive, and a cancel arriving afterwards finds nothing to free.
   */
  JobRef takeJob(const std::string &jobId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = jobsById_.find(jobId);
    if (it == jobsById_.end()) {
      return JobRef();
    }
    JobRef job = std::move(it->second);
    jobsById_.erase(it);
    return job;
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
};

}  // namespace happier_sherpa
