import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    installRemoteFirstPartyComponent,
    normalizeRemoteReleaseArch,
} from '@happier-dev/cli-common/systemTasks';

describe('happier relay host arch resolution', () => {
    let payloadRoot = '';

    afterEach(() => {
        if (payloadRoot) {
            rmSync(payloadRoot, { recursive: true, force: true });
            payloadRoot = '';
        }
    });

    it('normalizes remote aarch64 to arm64 for first-party payload selection', async () => {
        expect(normalizeRemoteReleaseArch('aarch64')).toBe('arm64');

        let observedArch: string | null = null;
        payloadRoot = mkdtempSync(join(tmpdir(), 'happier-relay-host-arch-'));
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);
        writeFileSync(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);

        await installRemoteFirstPartyComponent(
            {
                componentId: 'happier-server',
                channel: 'preview',
                ssh: {
                    target: 'dev@example.test',
                    auth: 'agent',
                },
            },
            {
                resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: normalizeRemoteReleaseArch('aarch64') }),
                runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
                copyLocalDirectoryToRemote: async () => undefined,
                preparePayload: async (params) => {
                    observedArch = params.arch;
                    return {
                        componentId: params.componentId,
                        channel: params.channel,
                        versionId: 'preview-1',
                        payloadRoot,
                        source: null,
                        cleanup: async () => undefined,
                    };
                },
                now: () => 123,
            },
        );

        expect(observedArch).toBe('arm64');
    });
});
