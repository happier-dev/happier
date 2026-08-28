import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TERMINAL_QA_WORKLOAD_IDS, listTerminalQaWorkloads } from './workloads';

const CANONICAL_TESTKIT_SOURCE_SHA256 = 'aa108d065eec225ea1169dceaeaa8199eebe90c245f972712a9dd5792b962527';
const CANONICAL_WORKLOAD_SHA256: Readonly<Record<string, string>> = Object.freeze({
    'ansi-burst': 'b30e0bb22682cc44b31be0a40a6ba7b4faf49044b67dfa821876331aadce0677',
    'heavy-tui-redraw': '91d05ced3ac3662551a2b2acacb50b61cb39f59cf317b8c5f2080f582ce4d05c',
    'alternate-screen': '69eb10e7178f8b54a1698f04cd903e5af4271cd2cdf9ec12a22a51e202a5c5e3',
    'cursor-style-churn': 'a30b882bfb48496c0b0c85f92b1ad2cc2a94e406f1819c50a971d20367fa509f',
    'wide-combining': 'da72484c26a4089ead2fd07ddfc6ab5aef2b07cd12fbd3dcc262c765502aecdf',
    'invalid-utf8-binary': '3d46d564a06e1511a02b6c88fa04ed2193d41a6acfc8d3ed29078d44f6b16bda',
    'bracketed-paste-echo': '6577c6c388e14a51119ec6064aa46634d228c4fe7a2f823a502f2e6a5fd035e8',
    'link-heavy-output': '965c7ba19326d67f0f95781d82ec0d4a4ab506d34eb6a98efc84155944af3f4b',
    'long-scrollback': 'e9f7b6a2c223b2a1bff38f2931b34952dc32f8566b2fc24c15b3130eb01969c4',
});

describe('terminal loaded-device QA workloads', () => {
    it('stays byte-for-byte aligned with the pinned canonical TERM testkit contract', () => {
        const canonicalSourcePath = fileURLToPath(new URL(
            '../../../../../../packages/tests/src/testkit/terminal/workloads.ts',
            import.meta.url,
        ));
        const sourceHash = createHash('sha256').update(readFileSync(canonicalSourcePath)).digest('hex');
        expect(sourceHash).toBe(CANONICAL_TESTKIT_SOURCE_SHA256);

        expect(TERMINAL_QA_WORKLOAD_IDS).toEqual(Object.keys(CANONICAL_WORKLOAD_SHA256));
        for (const workload of listTerminalQaWorkloads()) {
            expect(createHash('sha256').update(workload.bytes).digest('hex')).toBe(
                CANONICAL_WORKLOAD_SHA256[workload.id],
            );
            expect(workload.byteLength).toBe(workload.bytes.byteLength);
        }
    });
});
