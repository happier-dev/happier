import { describe, expect, it } from 'vitest';

import { isPluginUiExecutableArtifactHostCompatibleV1 } from './hostApi.js';
import { PLUGIN_UI_HOST_PROVIDED_PROTOCOL_SPECIFIERS } from './hostProvidedProtocolSubpaths.generated.js';

describe('executable artifact host-module admission', () => {
    const artifact = (hostModules?: readonly string[]) => ({ hostUiApiRange: '^1.1.0', executable: hostModules ? { hostModules } : {} });

    it('admits artifacts that rely only on modules this host provides, or record none', () => {
        expect(isPluginUiExecutableArtifactHostCompatibleV1(artifact())).toBe(true);
        expect(isPluginUiExecutableArtifactHostCompatibleV1(artifact(['react', PLUGIN_UI_HOST_PROVIDED_PROTOCOL_SPECIFIERS[0]!]))).toBe(true);
    });

    it('refuses an artifact built against a Protocol subpath this host does not provide', () => {
        expect(isPluginUiExecutableArtifactHostCompatibleV1(artifact(['@happier-dev/protocol/not/provided']))).toBe(false);
    });
});
