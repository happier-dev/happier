#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace happier_sherpa {

struct TtsJobState {
  std::atomic<bool> cancelled{false};
};

class TtsJobRegistry {
 public:
  explicit TtsJobRegistry(std::size_t maxCancelledTombstones = 512)
      : maxCancelledTombstones_(maxCancelledTombstones) {}

  TtsJobRegistry(const TtsJobRegistry &) = delete;
  TtsJobRegistry &operator=(const TtsJobRegistry &) = delete;

  TtsJobState *beginJob(const std::string &jobKey, bool *wasAlreadyCancelled) {
    if (wasAlreadyCancelled) {
      *wasAlreadyCancelled = false;
    }
    if (jobKey.empty()) {
      return nullptr;
    }

    auto state = std::make_unique<TtsJobState>();
    TtsJobState *statePtr = state.get();

    std::lock_guard<std::mutex> lock(mutex_);
    if (removeCancelledJobLocked(jobKey)) {
      if (wasAlreadyCancelled) {
        *wasAlreadyCancelled = true;
      }
      return nullptr;
    }

    jobs_[jobKey] = std::move(state);
    return statePtr;
  }

  void cancel(const std::string &jobKey) {
    if (jobKey.empty()) {
      return;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    auto active = jobs_.find(jobKey);
    if (active != jobs_.end()) {
      active->second->cancelled.store(true);
      return;
    }

    rememberCancelledJobLocked(jobKey);
  }

  bool finishJob(const std::string &jobKey) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto active = jobs_.find(jobKey);
    if (active == jobs_.end()) {
      return false;
    }

    const bool wasCancelled = active->second->cancelled.load();
    jobs_.erase(active);
    return wasCancelled;
  }

  std::size_t pendingCancelledCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return cancelledJobIds_.size();
  }

 private:
  bool removeCancelledJobLocked(const std::string &jobKey) {
    if (cancelledJobIds_.erase(jobKey) == 0) {
      return false;
    }

    auto orderIt = std::find(cancelledJobOrder_.begin(), cancelledJobOrder_.end(), jobKey);
    if (orderIt != cancelledJobOrder_.end()) {
      cancelledJobOrder_.erase(orderIt);
    }
    return true;
  }

  void rememberCancelledJobLocked(const std::string &jobKey) {
    const auto inserted = cancelledJobIds_.insert(jobKey).second;
    if (inserted) {
      cancelledJobOrder_.push_back(jobKey);
    }

    while (cancelledJobIds_.size() > maxCancelledTombstones_ && !cancelledJobOrder_.empty()) {
      const std::string oldest = cancelledJobOrder_.front();
      cancelledJobOrder_.pop_front();
      cancelledJobIds_.erase(oldest);
    }
  }

  const std::size_t maxCancelledTombstones_;
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::unique_ptr<TtsJobState>> jobs_;
  std::unordered_set<std::string> cancelledJobIds_;
  std::deque<std::string> cancelledJobOrder_;
};

}  // namespace happier_sherpa
