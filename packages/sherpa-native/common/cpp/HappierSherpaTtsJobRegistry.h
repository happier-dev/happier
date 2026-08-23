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
    if (retired_) {
      // The engine this registry belongs to was retired by a pack invalidation
      // while this caller held its lease. Admitting the job now would decode
      // against the superseded model, so it is refused as cancelled instead --
      // the caller leases again and gets an engine built from the new bytes.
      if (wasAlreadyCancelled) {
        *wasAlreadyCancelled = true;
      }
      return nullptr;
    }
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

  /**
   * Terminal state for an engine a pack invalidation has retired.
   *
   * Marks every job currently running cancelled -- without removing them, so each
   * synthesis still reports its own outcome through `finishJob` -- and refuses
   * every later `beginJob`. Both halves happen under one lock because leasing an
   * engine and registering a job on it are separate steps: without the refusal, a
   * synthesis that leased the engine just before the invalidation could register
   * just after it and decode to completion against the superseded model, which is
   * exactly what the installer awaits this call to prevent.
   *
   * Returns how many running jobs were marked. Idempotent.
   */
  std::size_t retire() {
    std::lock_guard<std::mutex> lock(mutex_);
    retired_ = true;
    for (auto &entry : jobs_) {
      entry.second->cancelled.store(true);
    }
    return jobs_.size();
  }

  bool retired() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return retired_;
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
  bool retired_ = false;
  std::unordered_map<std::string, std::unique_ptr<TtsJobState>> jobs_;
  std::unordered_set<std::string> cancelledJobIds_;
  std::deque<std::string> cancelledJobOrder_;
};

}  // namespace happier_sherpa
