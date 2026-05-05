import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = path.resolve(__dirname, '../public');

function expectedWrapper(options: {
    channel?: 'dev' | 'preview';
    product?: 'cli' | 'server';
}) {
    const lines = ['#!/usr/bin/env bash', 'set -euo pipefail', ''];

    if (options.channel) {
        lines.push(
            `export HAPPIER_CHANNEL="\${HAPPIER_CHANNEL:-${options.channel}}"`,
        );
    }
    if (options.product) {
        lines.push(
            `export HAPPIER_PRODUCT="\${HAPPIER_PRODUCT:-${options.product}}"`,
        );
    }

    lines.push('', 'curl -fsSL "https://happier.dev/install.sh" | bash -s -- "$@"', '');

    return lines.join('\n');
}

describe('shell installer entrypoints', () => {
    it('delegate channel-specific entrypoints to install.sh so wrapper logic cannot drift', () => {
        const cases = [
            ['install-dev', expectedWrapper({ channel: 'dev', product: 'cli' })],
            ['install-dev.sh', expectedWrapper({ channel: 'dev', product: 'cli' })],
            ['install-preview', expectedWrapper({ channel: 'preview', product: 'cli' })],
            [
                'install-preview.sh',
                expectedWrapper({ channel: 'preview', product: 'cli' }),
            ],
            ['install-server', expectedWrapper({ product: 'server' })],
            ['install-server.sh', expectedWrapper({ product: 'server' })],
        ] as const;

        for (const [entrypoint, expected] of cases) {
            const contents = readFileSync(path.join(publicDir, entrypoint), 'utf8');
            expect(contents).toBe(expected);
        }
    });
});
