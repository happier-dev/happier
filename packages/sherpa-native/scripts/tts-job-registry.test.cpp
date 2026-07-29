#include "../common/cpp/HappierSherpaTtsJobRegistry.h"

#include <cassert>
#include <string>

int main() {
  happier_sherpa::TtsJobRegistry registry(4);

  bool wasAlreadyCancelled = false;
  auto *first = registry.beginJob("job-active", &wasAlreadyCancelled);
  assert(first != nullptr);
  assert(!wasAlreadyCancelled);

  registry.cancel("job-active");
  assert(registry.finishJob("job-active"));

  registry.cancel("job-queued");
  auto *queued = registry.beginJob("job-queued", &wasAlreadyCancelled);
  assert(queued == nullptr);
  assert(wasAlreadyCancelled);
  assert(registry.pendingCancelledCount() == 0);

  auto *reusedId = registry.beginJob("job-queued", &wasAlreadyCancelled);
  assert(reusedId != nullptr);
  assert(!wasAlreadyCancelled);
  assert(!registry.finishJob("job-queued"));

  registry.cancel("stale-1");
  registry.cancel("stale-2");
  registry.cancel("stale-3");
  registry.cancel("stale-4");
  registry.cancel("stale-5");
  assert(registry.pendingCancelledCount() == 4);

  return 0;
}
