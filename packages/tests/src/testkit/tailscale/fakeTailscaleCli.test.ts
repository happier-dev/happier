import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { createFakeTailscaleCli } from './fakeTailscaleCli.js';

describe('createFakeTailscaleCli', () => {
    const created: Array<{ cleanup: () => void }> = [];

    afterEach(() => {
        while (created.length > 0) {
            created.pop()?.cleanup();
        }
    });

    it('records invocations and returns queued status output', () => {
        const fake = createFakeTailscaleCli({
            statusJsons: [
                {
                    BackendState: 'Running',
                    Self: { DNSName: 'relay.tailf00.ts.net.' },
                    CurrentTailnet: { Name: 'example-tailnet' },
                    TailscaleIPs: ['100.64.0.10'],
                    HaveNodeKey: true,
                    AuthURL: '',
                },
            ],
        });
        created.push(fake);

        const rootDir = dirname(fake.cliPath);
        const env = {
            ...process.env,
            HAPPIER_FAKE_TAILSCALE_STATE_PATH: join(rootDir, 'scenario.json'),
            HAPPIER_FAKE_TAILSCALE_LOG_PATH: join(rootDir, 'invocations.log'),
        };

        expect(() => execFileSync(process.execPath, [fake.cliPath, 'status', '--json'], { env })).not.toThrow();
        expect(fake.readInvocations()).toEqual([['status', '--json']]);
    });
});
