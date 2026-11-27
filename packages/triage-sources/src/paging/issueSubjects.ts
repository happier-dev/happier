import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PluginSubjectKindListInputV1Schema, type PluginSubjectKindListResultV1 } from '@happier-dev/plugin-sdk/automations';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
    decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, MAX_TRIAGE_LIST_WINDOW_ROWS_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    TriageReadConfiguredSourceInstancesResultV1Schema, TriageScanContinuationV1Schema,
    type TriageScanInputV1, type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { deriveTriageConfiguredSourceInstanceDigestV1 } from '../authorization/configuredSourceCurrentness.js';

const cursorSchema = defineProtocolObject({
    v: defineProtocolLiteral(1), sourceDigest: defineProtocolString({ minLength: 1 }),
    limit: defineProtocolNumber({ integer: true, minimum: 1 }), query: defineProtocolString(),
    continuation: TriageScanContinuationV1Schema.optional(),
}, { policy: 'closed' });

/** A picker request reads one configured source and one native page on demand. */
export async function listTriageIssueSubjectPageV1<Context extends Pick<PluginAccountActionContext, 'signal' | 'services'>>(
    raw: unknown,
    context: Context,
    options: Readonly<{
        source: Readonly<{ pluginId: string; localId: string }>;
        scan: (input: TriageScanInputV1, context: Context) => Promise<TriageScanResultV1>;
    }>,
): Promise<PluginSubjectKindListResultV1> {
    const input = PluginSubjectKindListInputV1Schema.parse(raw);
    const query = input.query?.trim().toLowerCase() ?? '';
    const limit = input.limit ?? MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
    const list = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await context.services.actions.execute(
        TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, { v: 1, source: options.source }, { signal: context.signal },
    ));
    context.signal.throwIfAborted();
    if (list.kind !== 'read' || list.status !== 'complete') throw new PluginError({
        code: 'triage_issue_sources_unavailable', message: 'Configured issue sources are unavailable.',
    });
    const sources = list.instances.filter(row => row.lifecycle === 'active').map(row => row.configured)
        .sort((left, right) => left.instance.sourceInstanceId.localeCompare(right.instance.sourceInstanceId));
    const invalidCursor = () => new PluginError({ code: 'triage_issue_subject_cursor_invalid', message: 'Issue sources changed. Reload the issue list.' });
    let sourceIndex = 0;
    let continuation: ReturnType<typeof cursorSchema.parse>['continuation'];
    if (input.cursor !== undefined) {
        const cursor = cursorSchema.safeParse(decodeTriagePagingTokenV1(input.cursor));
        if (!cursor.success || cursor.data.query !== query || cursor.data.limit !== limit) throw invalidCursor();
        const { sourceDigest, continuation: native } = cursor.data;
        sourceIndex = sources.findIndex(source => deriveTriageConfiguredSourceInstanceDigestV1(source) === sourceDigest);
        if (sourceIndex === -1) throw invalidCursor();
        continuation = native;
    }
    const instance = sources[sourceIndex];
    if (!instance) return { items: [], nextCursor: null };
    const scope = { v: 1 as const, instance, ...(query ? { query } : {}) };
    const scan: TriageScanInputV1 = continuation === undefined
        ? { ...scope, page: { kind: 'initial', limit } }
        : { ...scope, page: { kind: 'continuation', continuation } };
    const result = await options.scan(scan, context);
    context.signal.throwIfAborted();
    if (result.kind === 'failed') throw new PluginError({
        code: result.failure.code, message: 'The selected issue source could not be read.', details: { failure: result.failure },
    });
    const items = result.observations.flatMap(observation => {
        if (observation.kind !== 'present' || observation.localRef.kindId !== 'issue') return [];
        const { title, designation } = observation.snapshot;
        if (query && !title.toLowerCase().includes(query) && !designation?.toLowerCase().includes(query)) return [];
        return [{ identity: observation.localRef, label: designation ? `${designation} · ${title}` : title }];
    });
    const nextSource = result.kind === 'page' ? instance : sources[sourceIndex + 1];
    if (!nextSource) return { items, nextCursor: null };
    const nextCursor = encodeTriagePagingTokenV1({ v: 1, sourceDigest: deriveTriageConfiguredSourceInstanceDigestV1(nextSource), query, limit,
        ...(result.kind === 'page' ? { continuation: result.continuation } : {}),
    });
    if (nextCursor === null) throw invalidCursor();
    return { items, nextCursor };
}
