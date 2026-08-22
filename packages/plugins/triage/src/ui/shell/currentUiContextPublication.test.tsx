// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiContextEnrichmentV1, PluginUiHostApi, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { useTriageCurrentUiContextPublication } from './root.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CurrentContextPublisher = Pick<PluginUiHostApi, 'publishCurrentUiContext'>;
type CurrentContextRecord = Readonly<{
    enrichment: PluginUiContextEnrichmentV1;
    commandIds: readonly string[];
}>;

const CONTEXT_A: PluginUiContextEnrichmentV1 = {
    entity: { kind: 'issue', label: 'Issue A' },
    commands: [{
        title: 'Open issue B',
        command: { kind: 'openSurface', destination: 'triage', subPath: 'issue-b' },
    }],
};
const CONTEXT_B: PluginUiContextEnrichmentV1 = {
    entity: { kind: 'issue', label: 'Issue B' },
    commands: [{
        title: 'Open issue A',
        command: { kind: 'openSurface', destination: 'triage', subPath: 'issue-a' },
    }],
};

/** The actual host boundary owns opaque command ids; Triage supplies data only. */
function createCurrentContextHost(): Readonly<{
    publisher: CurrentContextPublisher;
    read(): CurrentContextRecord | null;
    resolves(commandId: string): boolean;
}> {
    let nextCommandId = 0;
    let current: CurrentContextRecord | null = null;
    const publisher: CurrentContextPublisher = {
        publishCurrentUiContext(enrichment): void {
            current = enrichment === null
                ? null
                : Object.freeze({
                    enrichment,
                    commandIds: Object.freeze((enrichment.commands ?? []).map(
                        () => `current-ui-command:${++nextCommandId}`,
                    )),
                });
        },
    };
    return Object.freeze({
        publisher,
        read: () => current,
        resolves: (commandId) => current?.commandIds.includes(commandId) ?? false,
    });
}

function PublicationProbe(props: Readonly<{
    hostApi: CurrentContextPublisher;
    enrichment: PluginUiContextEnrichmentV1;
    onSiblingLayoutRead: () => void;
}>): null {
    useTriageCurrentUiContextPublication(props.hostApi, props.enrichment);
    React.useLayoutEffect(() => { props.onSiblingLayoutRead(); }, [props.enrichment, props.onSiblingLayoutRead]);
    return null;
}

function createPublicationProbeSurface(input: Readonly<{
    hostApi: CurrentContextPublisher;
    onSiblingLayoutRead: () => void;
}>): Readonly<{
    surface: RenderSurface;
    replace(enrichment: PluginUiContextEnrichmentV1): void;
}> {
    let setEnrichment: React.Dispatch<React.SetStateAction<PluginUiContextEnrichmentV1>> | null = null;
    const surface = defineUiSurface(() => {
        const [enrichment, setCurrentEnrichment] = React.useState(CONTEXT_A);
        setEnrichment = setCurrentEnrichment;
        return (
            <PublicationProbe
                hostApi={input.hostApi}
                enrichment={enrichment}
                onSiblingLayoutRead={input.onSiblingLayoutRead}
            />
        );
    });
    return Object.freeze({
        surface,
        replace(enrichment) {
            if (setEnrichment === null) throw new Error('publication probe has not mounted');
            setEnrichment(enrichment);
        },
    });
}

const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('Triage current UI context publication', () => {
    it('publishes B before a sibling layout reader and makes the A command id inert', async () => {
        const host = createCurrentContextHost();
        let aCommandId: string | null = null;
        const layoutReads: Readonly<{
            context: CurrentContextRecord | null;
            aCommandStillCurrent: boolean;
        }>[] = [];
        const probe = createPublicationProbeSurface({
            hostApi: host.publisher,
            onSiblingLayoutRead: () => {
                layoutReads.push(Object.freeze({
                    context: host.read(),
                    aCommandStillCurrent: aCommandId !== null && host.resolves(aCommandId),
                }));
            },
        });
        const fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage-current-context-publication',
                generation: 'triage-current-context-publication-test',
            },
            surface: probe.surface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        });
        mounted.push(fixture);

        const aContext = host.read();
        expect(aContext?.enrichment.entity).toEqual({ kind: 'issue', label: 'Issue A' });
        aCommandId = aContext?.commandIds[0] ?? null;
        if (aCommandId === null) throw new Error('expected A to publish an opaque command id');
        expect(host.resolves(aCommandId)).toBe(true);
        layoutReads.length = 0;

        await act(async () => {
            probe.replace(CONTEXT_B);
        });

        const bLayoutRead = layoutReads.at(-1);
        expect(bLayoutRead?.context?.enrichment.entity).toEqual({ kind: 'issue', label: 'Issue B' });
        expect(bLayoutRead?.aCommandStillCurrent).toBe(false);

        await fixture.dispose();
        mounted.splice(mounted.indexOf(fixture), 1);
        expect(host.read()).toBeNull();
    });
});
