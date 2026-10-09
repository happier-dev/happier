import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import { resolveInstalledJavaScriptTool } from '@happier-dev/cli-common/agents';
import { isDeniedPathOnlyRuntimeName } from '@/plugins/runtime/exec/system/tools/runtimeDeny';
import type { ProjectNativeCommandIo } from './projectNativeResolution';

/** Passive installed-tool resolution shared by definition inspection and setup review. */
export const projectNativeSystemIo: ProjectNativeCommandIo = {
  async resolveTool(tool, request) {
    request.signal?.throwIfAborted();
    // The runtime owner returns installed package metadata plus its actual JS
    // entrypoint; a PATH package-manager shim never becomes the executable.
    if (isDeniedPathOnlyRuntimeName(tool)) {
      const installed = await resolveInstalledJavaScriptTool(tool);
      request.signal?.throwIfAborted();
      return installed;
    }
    const resolved = await createDaemonSpawnToolResolutionContext({ processEnv: process.env,
      ...(request.signal ? { signal: request.signal } : {}) }).resolveSystemTool({ toolId: tool, reason: 'Inspect an installed Project native tool' });
    request.signal?.throwIfAborted();
    if (resolved.ok && isDeniedPathOnlyRuntimeName(resolved.command)) return null;
    // PATH lookup proves presence only. A declaration is never installed-version evidence.
    return resolved.ok ? { executablePath: resolved.command, args: resolved.args } : null;
  },
};
