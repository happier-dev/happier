import * as React from 'react';

import {
    ComposerControlStateV1Schema,
    isComposerControlStateContentTypeV1,
    MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
    type ComposerControlStateV1,
} from '@happier-dev/protocol';
import type {
    PluginUiResourceReference,
    PluginUiResourceSnapshot,
} from '@happier-dev/plugin-ui/hostApi';

import {
    PluginContextualResourceState,
    type PluginContextualResourceBinding,
} from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';

function parseComposerControlResourceState(
    snapshot: PluginUiResourceSnapshot | null,
): ComposerControlStateV1 | null {
    const value = snapshot?.value;
    if (!value || !isComposerControlStateContentTypeV1(value.contentType)) return null;
    // Manifest admission already bounds this Resource, but the bytes arrive
    // from a live producer: check the length the frame budget was derived from
    // before decoding and parsing the whole payload on the UI thread.
    if (value.bytes.byteLength > MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1) return null;

    try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes));
        const result = ComposerControlStateV1Schema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

type ComposerControlResourceStateScope = Readonly<{
    accountLifetime: PluginContextualResourceBinding['accountLifetime'];
    bindingKey: string;
    resourceKey: string;
}>;

type ComposerControlResourceStateRecord = Readonly<{
    scope: ComposerControlResourceStateScope;
    value: ComposerControlStateV1 | null;
    digest: string | undefined;
}>;

/**
 * The Composer control's semantic last-known-good value and the exact
 * independent-dimension observation from the canonical Resource store.
 * Keeping both prevents a consumer from mistaking a retained value for a
 * fresh, error-free, or live subscription state.
 */
export type ComposerControlResourceStateProjection = Readonly<{
    state: ComposerControlStateV1 | null;
    resource: PluginUiResourceSnapshot | null;
}>;

function resourceReferenceKey(resource: PluginUiResourceReference): string {
    return typeof resource === 'string'
        ? `local:${resource}`
        : `qualified:${resource.pluginId}\u0000${resource.localId}`;
}

function resourceContextKey(binding: PluginContextualResourceBinding): string {
    const context = binding.context;
    switch (context.kind) {
        case 'global':
            return 'global';
        case 'session':
            return `session:${context.sessionId}`;
        case 'surface':
            return `surface:${context.mountInstanceKey}\u0000${JSON.stringify(context.launchInput)}`;
    }
}

function createComposerControlResourceStateScope(input: Readonly<{
    binding: PluginContextualResourceBinding;
    resource: PluginUiResourceReference;
}>): ComposerControlResourceStateScope {
    return Object.freeze({
        accountLifetime: input.binding.accountLifetime,
        bindingKey: JSON.stringify([
            input.binding.pluginId,
            input.binding.machineId,
            input.binding.serverId,
            input.binding.expectedGeneration,
            resourceContextKey(input.binding),
        ]),
        resourceKey: resourceReferenceKey(input.resource),
    });
}

function areComposerControlResourceStateScopesEquivalent(
    left: ComposerControlResourceStateScope,
    right: ComposerControlResourceStateScope,
): boolean {
    return left.accountLifetime === right.accountLifetime
        && left.bindingKey === right.bindingKey
        && left.resourceKey === right.resourceKey;
}

/**
 * Decodes the one declared Composer-control Resource through the incumbent
 * contextual Resource owner. Last-known-good adoption is added below this
 * narrow semantic boundary rather than to the generic transport store.
 */
export function useComposerControlResourceState(input: Readonly<{
    binding: PluginContextualResourceBinding;
    resource: PluginUiResourceReference;
    snapshot: PluginUiResourceSnapshot | null;
    isCurrent: () => boolean;
}>): ComposerControlResourceStateProjection {
    const candidateScope = createComposerControlResourceStateScope({
        binding: input.binding,
        resource: input.resource,
    });
    const scopeRef = React.useRef<ComposerControlResourceStateScope | null>(null);
    const previousScope = scopeRef.current;
    const scope = previousScope === null
        || !areComposerControlResourceStateScopesEquivalent(previousScope, candidateScope)
        ? candidateScope
        : previousScope;
    scopeRef.current = scope;
    const [record, setRecord] = React.useState<ComposerControlResourceStateRecord>(() => Object.freeze({
        scope,
        value: null,
        digest: undefined as string | undefined,
    }));
    const isCurrent = input.binding.accountLifetime.isCurrent() && input.isCurrent();

    // A changed Resource binding is an authoritative replacement. Never allow
    // a prior control's semantic LKG to appear while the new lease starts.
    if (record.scope !== scope) {
        setRecord(Object.freeze({
            scope,
            value: null,
            digest: undefined,
        }));
    }

    const resourceValue = input.snapshot?.value;
    const resourceDigest = input.snapshot?.digest ?? resourceValue?.digest;
    const reportedLosingDigestRef = React.useRef<Readonly<{
        scope: ComposerControlResourceStateScope;
        digest: string | undefined;
    }> | null>(null);
    React.useEffect(() => {
        if (!input.binding.accountLifetime.isCurrent() || !input.isCurrent()) {
            setRecord((current) => (
                current.scope === scope && (current.value !== null || current.digest !== undefined)
                    ? Object.freeze({ scope, value: null, digest: undefined })
                    : current
            ));
            return;
        }
        if (!resourceValue) return;

        // Snapshot freshness, pending state, errors, and subscription state are
        // projected independently below. Once this scope has already accepted
        // a content digest, a new observation of that same content need not
        // decode and validate it again to keep those Resource facts current.
        const reported = reportedLosingDigestRef.current;
        const hasUnchangedAcceptedDigest = resourceDigest !== undefined
            && record.scope === scope
            && record.value !== null
            && record.digest === resourceDigest;
        const hasUnchangedRejectedDigest = resourceDigest !== undefined
            && reported?.scope === scope
            && reported.digest === resourceDigest;
        if (hasUnchangedAcceptedDigest || hasUnchangedRejectedDigest) return;

        const candidate = parseComposerControlResourceState(input.snapshot);
        if (candidate === null) {
            // Wrong MIME, invalid UTF-8/JSON, or a schema mismatch is a
            // losing update. The last valid semantic control state remains
            // authoritative until the incumbent Resource owner publishes a
            // valid replacement or this scope retires.
            if (reported?.scope !== scope || reported.digest !== resourceDigest) {
                reportedLosingDigestRef.current = Object.freeze({ scope, digest: resourceDigest });
                logPluginSurfaceDiagnostic({
                    pluginId: input.binding.pluginId,
                    contributionId: typeof input.resource === 'string'
                        ? input.resource
                        : input.resource.localId,
                    surfaceId: 'composer-control-resource',
                }, {
                    code: 'composer_control_resource_invalid',
                    severity: 'warning',
                    details: { digest: resourceDigest ?? null },
                });
            }
            return;
        }
        setRecord((current) => (
            current.scope === scope
            && input.binding.accountLifetime.isCurrent()
            && input.isCurrent()
            && (current.digest !== resourceDigest || current.value === null)
                ? Object.freeze({ scope, value: candidate, digest: resourceDigest })
                : current
        ));
    }, [input.binding.accountLifetime, input.isCurrent, input.snapshot, isCurrent, record, resourceDigest, resourceValue, scope]);

    const state = isCurrent && record.scope === scope ? record.value : null;
    const resource = isCurrent ? input.snapshot : null;
    return React.useMemo(() => Object.freeze({ state, resource }), [resource, state]);
}

function ComposerControlResourceStateContent(props: Readonly<{
    binding: PluginContextualResourceBinding;
    resource: PluginUiResourceReference;
    snapshot: PluginUiResourceSnapshot | null;
    isCurrent: () => boolean;
    children: (
        state: ComposerControlStateV1 | null,
        resource: PluginUiResourceSnapshot | null,
    ) => React.ReactNode;
}>): React.ReactElement {
    const projection = useComposerControlResourceState({
        binding: props.binding,
        resource: props.resource,
        snapshot: props.snapshot,
        isCurrent: props.isCurrent,
    });
    return <>{props.children(projection.state, projection.resource)}</>;
}

export function ComposerControlResourceState(props: Readonly<{
    binding: PluginContextualResourceBinding;
    resource: PluginUiResourceReference;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    children: (
        state: ComposerControlStateV1 | null,
        resource: PluginUiResourceSnapshot | null,
    ) => React.ReactNode;
}>): React.ReactElement {
    const isCurrent = React.useCallback((): boolean => (
        props.signal?.aborted !== true
        && props.binding.accountLifetime.isCurrent()
        && props.isCurrent?.() !== false
    ), [props.binding.accountLifetime, props.isCurrent, props.signal]);

    return (
        <PluginContextualResourceState
            binding={props.binding}
            resource={props.resource}
            isCurrent={isCurrent}
            signal={props.signal}
        >
            {(snapshot) => (
                <ComposerControlResourceStateContent
                    binding={props.binding}
                    resource={props.resource}
                    snapshot={snapshot}
                    isCurrent={isCurrent}
                >
                    {props.children}
                </ComposerControlResourceStateContent>
            )}
        </PluginContextualResourceState>
    );
}
