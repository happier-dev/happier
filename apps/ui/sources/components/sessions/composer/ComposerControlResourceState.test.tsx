import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
    COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
} from '@happier-dev/protocol';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';

import type { PluginContextualResourceBinding } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';

import {
    useComposerControlResourceState,
    type ComposerControlResourceStateProjection,
} from './ComposerControlResourceState';

function createBinding(expectedGeneration = 'generation-7'): PluginContextualResourceBinding {
    return {
        accountLifetime: {
            scope: { serverId: 'server-1', accountId: 'account-1' },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => {} }),
        },
        pluginId: 'acme.controls',
        machineId: 'machine-1',
        serverId: 'server-1',
        expectedGeneration,
        context: { kind: 'session', sessionId: 'session-1' },
    };
}

function resourceSnapshot(input: Readonly<{
    contentType: string;
    document: string;
    digest: string;
}>): PluginUiResourceSnapshot {
    return {
        value: {
            contentType: input.contentType,
            digest: input.digest,
            bytes: new TextEncoder().encode(input.document),
        },
        digest: input.digest,
        freshness: 'fresh',
        pending: 'idle',
        subscription: 'live',
    };
}

describe('ComposerControlResourceState', () => {
    it('keeps the retained semantic value together with the canonical stale Resource observation', async () => {
        let observed: unknown = null;
        const binding = createBinding();
        const valid = resourceSnapshot({
            contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
            document: JSON.stringify({ label: 'Ready', count: 3, enabled: true }),
            digest: `sha256:${'1'.repeat(64)}`,
        });
        const stale = {
            ...valid,
            freshness: 'stale' as const,
            pending: 'refresh' as const,
            error: { code: 'transport_unavailable', message: 'Resource refresh failed.' },
            subscription: 'reconnecting' as const,
        } satisfies PluginUiResourceSnapshot;

        function Probe(props: Readonly<{ snapshot: PluginUiResourceSnapshot | null }>): null {
            observed = useComposerControlResourceState({
                binding,
                resource: 'control-state',
                snapshot: props.snapshot,
                isCurrent: () => true,
            });
            return null;
        }

        let tree: ReturnType<typeof create> | null = null;
        await act(async () => {
            tree = create(<Probe snapshot={valid} />);
        });
        await act(async () => {
            tree?.update(<Probe snapshot={stale} />);
        });

        expect(observed).toEqual({
            state: { label: 'Ready', count: 3, enabled: true },
            resource: stale,
        });

        await act(async () => { tree?.unmount(); });
    });

    it('retains the last valid semantic state when a later Resource update has the wrong type or malformed JSON', async () => {
        const observed: { current: ComposerControlResourceStateProjection | null } = { current: null };
        const binding = createBinding();
        const valid = resourceSnapshot({
            contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
            document: JSON.stringify({ label: 'Ready', count: 3, enabled: true }),
            digest: `sha256:${'a'.repeat(64)}`,
        });
        const wrongType = resourceSnapshot({
            contentType: 'application/json',
            document: JSON.stringify({ label: 'Wrong type' }),
            digest: `sha256:${'b'.repeat(64)}`,
        });
        const malformed = resourceSnapshot({
            contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
            document: '{',
            digest: `sha256:${'c'.repeat(64)}`,
        });
        const schemaMismatch = resourceSnapshot({
            contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
            document: JSON.stringify({ label: 'Wrong shape', count: 'three' }),
            digest: `sha256:${'d'.repeat(64)}`,
        });

        function Probe(props: Readonly<{ snapshot: PluginUiResourceSnapshot | null }>): null {
            observed.current = useComposerControlResourceState({
                binding,
                resource: 'control-state',
                snapshot: props.snapshot,
                isCurrent: () => true,
            });
            return null;
        }

        let tree: ReturnType<typeof create> | null = null;
        await act(async () => {
            tree = create(<Probe snapshot={valid} />);
        });
        expect(observed.current?.state).toEqual({ label: 'Ready', count: 3, enabled: true });

        await act(async () => {
            tree?.update(<Probe snapshot={wrongType} />);
        });
        expect(observed.current?.state).toEqual({ label: 'Ready', count: 3, enabled: true });

        await act(async () => {
            tree?.update(<Probe snapshot={malformed} />);
        });
        expect(observed.current?.state).toEqual({ label: 'Ready', count: 3, enabled: true });

        await act(async () => {
            tree?.update(<Probe snapshot={schemaMismatch} />);
        });
        expect(observed.current?.state).toEqual({ label: 'Ready', count: 3, enabled: true });

        await act(async () => { tree?.unmount(); });
    });

    it('drops prior semantic state when its exact binding changes or the caller becomes stale', async () => {
        const observed: { current: ComposerControlResourceStateProjection | null } = { current: null };
        let current = true;
        const firstBinding = createBinding('generation-7');
        // Keep the Account lifetime and every other binding fact fixed so the
        // assertion specifically proves generation-scoped LKG retirement.
        const secondBinding: PluginContextualResourceBinding = {
            ...firstBinding,
            expectedGeneration: 'generation-8',
        };
        const first = resourceSnapshot({
            contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
            document: JSON.stringify({ label: 'First generation' }),
            digest: `sha256:${'e'.repeat(64)}`,
        });
        const second = resourceSnapshot({
            contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
            document: JSON.stringify({ label: 'Second generation' }),
            digest: `sha256:${'f'.repeat(64)}`,
        });
        const invalidAfterRetirement = resourceSnapshot({
            contentType: 'application/json',
            document: JSON.stringify({ label: 'Must not revive' }),
            digest: `sha256:${'0'.repeat(64)}`,
        });

        function Probe(props: Readonly<{
            binding: PluginContextualResourceBinding;
            snapshot: PluginUiResourceSnapshot | null;
        }>): null {
            observed.current = useComposerControlResourceState({
                binding: props.binding,
                resource: 'control-state',
                snapshot: props.snapshot,
                isCurrent: () => current,
            });
            return null;
        }

        let tree: ReturnType<typeof create> | null = null;
        await act(async () => {
            tree = create(<Probe binding={firstBinding} snapshot={first} />);
        });
        expect(observed.current?.state).toEqual({ label: 'First generation' });

        await act(async () => {
            tree?.update(<Probe binding={secondBinding} snapshot={null} />);
        });
        expect(observed.current).toEqual({ state: null, resource: null });

        await act(async () => {
            tree?.update(<Probe binding={secondBinding} snapshot={second} />);
        });
        expect(observed.current?.state).toEqual({ label: 'Second generation' });

        current = false;
        await act(async () => {
            tree?.update(<Probe binding={secondBinding} snapshot={second} />);
        });
        expect(observed.current).toEqual({ state: null, resource: null });

        current = true;
        await act(async () => {
            tree?.update(<Probe binding={secondBinding} snapshot={invalidAfterRetirement} />);
        });
        expect(observed.current).toEqual({ state: null, resource: invalidAfterRetirement });

        await act(async () => { tree?.unmount(); });
    });
});
