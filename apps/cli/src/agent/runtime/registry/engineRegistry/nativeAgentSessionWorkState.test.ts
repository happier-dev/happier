import { describe, expect, it } from 'vitest';

import {
    SessionWorkStateItemV1Schema,
    buildDeterministicSessionWorkStateItemId,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { HostRuntimeLimitMeasurementSample } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { deterministicStringify } from '@/utils/deterministicJson';

import { createNativeAgentSessionWorkStateService } from './nativeAgentSessionWorkState';

const MAX_SOURCE_JSON_BYTES = 256 * 1024;
const SOURCE_FAMILY = 'plugin-agent/acme.agent/runtime/tasks';

function buildRequest(totalSummaryCharacters: number) {
    let remaining = totalSummaryCharacters;
    const items = Array.from({ length: 100 }, (_, index) => {
        const summaryLength = Math.min(8_000, remaining);
        remaining -= summaryLength;
        return {
            localId: `task-${index}`,
            kind: 'task' as const,
            origin: 'vendor' as const,
            status: 'active' as const,
            title: `Task ${index}`,
            summary: 'x'.repeat(summaryLength),
            updatedAtMs: 1,
        };
    });
    if (remaining !== 0) throw new Error('summary fixture exceeded source capacity');
    return {
        sourceSequence: 1,
        observedAtMs: 1,
        items,
        primaryLocalId: 'task-0',
    };
}

function normalizedBytes(totalSummaryCharacters: number): number {
    const request = buildRequest(totalSummaryCharacters);
    const items = request.items.map((item) => SessionWorkStateItemV1Schema.parse({
        id: buildDeterministicSessionWorkStateItemId({
            kind: item.kind,
            sourceFamily: SOURCE_FAMILY,
            stableParts: [item.localId],
        }),
        kind: item.kind,
        origin: item.origin,
        status: item.status,
        title: item.title,
        summary: item.summary,
        agentId: 'runtime',
        updatedAt: item.updatedAtMs,
    }));
    return Buffer.byteLength(deterministicStringify({
        sourceSequence: request.sourceSequence,
        observedAtMs: request.observedAtMs,
        items,
        primaryItemId: items[0]?.id ?? null,
    }), 'utf8');
}

function findSummaryCharactersForBytes(targetBytes: number): number {
    let low = 0;
    let high = 800_000;
    while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        const bytes = normalizedBytes(midpoint);
        if (bytes === targetBytes) return midpoint;
        if (bytes < targetBytes) low = midpoint + 1;
        else high = midpoint - 1;
    }
    throw new Error(`could not construct ${targetBytes} byte source fixture`);
}

function createHarness(
    samples: HostRuntimeLimitMeasurementSample[],
    declarations = [{ id: 'tasks', itemKinds: ['task' as const] }],
) {
    let metadata: Metadata = {
        path: '/repo',
        host: 'test-host',
        homeDir: '/home/test',
        happyHomeDir: '/home/test/.happier',
        happyLibDir: '/home/test/.happier/lib',
        happyToolsDir: '/home/test/.happier/tools',
    };
    const service = createNativeAgentSessionWorkStateService({
        session: {
            sessionId: 'session-work-state',
            async updateMetadata(updater) {
                metadata = updater(metadata);
            },
        },
        pluginId: 'acme.agent',
        contributionId: 'runtime',
        agentId: 'runtime',
        generationId: 'generation-1',
        declarations,
        isCurrent: () => true,
        recordRuntimeLimitMeasurement: (sample) => samples.push(sample),
    });
    return {
        publisher: service.publisher('tasks'),
        publisherFor: (sourceId: string) => service.publisher(sourceId),
        readMetadata: () => metadata,
    };
}

describe('native Agent work-state measurement boundary', () => {
    it('accepts exactly 256 KiB, rejects +1 without persistence, and records source plus aggregate bytes', async () => {
        const exactSummaryCharacters = findSummaryCharactersForBytes(MAX_SOURCE_JSON_BYTES);
        expect(normalizedBytes(exactSummaryCharacters)).toBe(MAX_SOURCE_JSON_BYTES);
        expect(normalizedBytes(exactSummaryCharacters + 1)).toBe(MAX_SOURCE_JSON_BYTES + 1);

        const exactSamples: HostRuntimeLimitMeasurementSample[] = [];
        const exact = createHarness(exactSamples);
        await expect(exact.publisher.publish(buildRequest(exactSummaryCharacters)))
            .resolves.toMatchObject({ status: 'applied' });
        expect(exactSamples[0]).toEqual({
            family: 'native-work-state-source',
            decodedBytes: MAX_SOURCE_JSON_BYTES,
            itemCount: 100,
        });
        const aggregate = Reflect.get(exact.readMetadata(), 'sessionWorkStateV1') as Record<string, unknown>;
        expect(exactSamples[1]).toEqual({
            family: 'native-work-state-aggregate',
            decodedBytes: Buffer.byteLength(JSON.stringify(aggregate), 'utf8'),
            itemCount: 100,
        });

        const oversizeSamples: HostRuntimeLimitMeasurementSample[] = [];
        const oversize = createHarness(oversizeSamples);
        await expect(oversize.publisher.publish(buildRequest(exactSummaryCharacters + 1)))
            .resolves.toMatchObject({
                status: 'conflict',
                diagnostic: { code: 'agent_work_state_invalid_publication' },
            });
        expect(oversize.readMetadata()).not.toHaveProperty('sessionWorkStateV1');
        expect(oversizeSamples).toEqual([]);
    });

    it('measures the merged aggregate across independently declared sources', async () => {
        const samples: HostRuntimeLimitMeasurementSample[] = [];
        const harness = createHarness(samples, [
            { id: 'tasks', itemKinds: ['task'] },
            { id: 'review', itemKinds: ['task'] },
        ]);
        const request = {
            sourceSequence: 1,
            observedAtMs: 1,
            items: [{
                localId: 'one',
                kind: 'task' as const,
                origin: 'vendor' as const,
                status: 'active' as const,
                title: 'One',
                updatedAtMs: 1,
            }],
        };

        await expect(harness.publisherFor('tasks').publish(request))
            .resolves.toMatchObject({ status: 'applied' });
        await expect(harness.publisherFor('review').publish({
            ...request,
            observedAtMs: 2,
            items: [{ ...request.items[0], localId: 'two', title: 'Two', updatedAtMs: 2 }],
        })).resolves.toMatchObject({ status: 'applied' });

        const aggregate = Reflect.get(harness.readMetadata(), 'sessionWorkStateV1') as {
            items: readonly unknown[];
        };
        expect(aggregate.items).toHaveLength(2);
        expect(samples.at(-1)).toEqual({
            family: 'native-work-state-aggregate',
            decodedBytes: Buffer.byteLength(JSON.stringify(aggregate), 'utf8'),
            itemCount: 2,
        });
    });
});
