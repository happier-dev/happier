import { configuration } from '@/configuration';
import { createCustomAcpAdmittedRuntimeFixture } from '@/plugins/testkit/customAcp';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

/** Real source activation through the canonical SDK fixture; not packaged-byte evidence. */
export function createCustomAcpAdmissionRuntimeFixture() {
  return createCustomAcpAdmittedRuntimeFixture({
    happyHomeDir: configuration.happyHomeDir,
    controller: pluginReloadController,
  });
}
