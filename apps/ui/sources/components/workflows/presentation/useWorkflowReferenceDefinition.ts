import * as React from 'react';
import { parseWorkflowDefinitionRefV1, resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useWorkflowPluginSource } from '../library/workflowLibraryReads';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import { formatWorkflowDefinitionLibraryTitle } from './workflowProblemPresentation';

/** Accessible definition content, shared by child bindings and trigger inputs. Saved/shared
 * references always use Get: list metadata is not content-disclosure authority. */
export function useWorkflowReferenceDefinition(ref: string | null, libraryEnabled = true, accountLifetime?: ServerAccountScopeLifetime | null): Readonly<{
    definition: WorkflowDefinitionV1 | null;
    /** Saved/plugin identity from this exact read; built-in titles belong to the catalog. */
    title: string | null;
    status: 'idle' | 'loading' | 'failed' | 'ready';
    retry: () => void;
}> {
    accountLifetime = useWorkflowAccountLifetime(accountLifetime);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = accountLifetime === undefined ? activeLifetime : accountLifetime;
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const reference = parseWorkflowDefinitionRefV1(ref);
    const plugin = useWorkflowPluginSource(reference?.kind === 'plugin' ? ref : null, libraryEnabled, accountLifetime);
    const artifactId = reference?.kind === 'artifact' ? reference.artifactId : null;
    const [attempt, setAttempt] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{
        ref: string; scopeKey: string; definition: WorkflowDefinitionV1 | null; title: string | null; failed: boolean;
        lifetime: ActiveServerAccountScopeLifetime;
    }> | null>(null);
    React.useEffect(() => {
        if (!libraryEnabled || artifactId === null || scopeKey === null || lifetime === null) return;
        const controller = new AbortController();
        setRead(null);
        void getWorkflowDefinition({ definitionId: artifactId, signal: controller.signal,
            ...(accountLifetime === undefined ? {} : { accountLifetime }) }).then((result) => {
            if (!controller.signal.aborted && lifetime?.isCurrent()) {
                setRead({ ref: artifactId, scopeKey, definition: result.definition, title: formatWorkflowDefinitionLibraryTitle(result), failed: false, lifetime });
            }
        }).catch(() => {
            if (!controller.signal.aborted && lifetime?.isCurrent()) {
                setRead({ ref: artifactId, scopeKey, definition: null, title: null, failed: true, lifetime });
            }
        });
        return () => controller.abort();
    }, [artifactId, attempt, libraryEnabled, lifetime, scopeKey, accountLifetime]);
    const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
    if (ref === null) return { definition: null, title: null, status: 'idle', retry };
    if (reference?.kind === 'builtin') {
        const definition = resolveBuiltinWorkflowDefinitionV1(reference.id)?.definition ?? null;
        return { definition, title: null, status: definition === null ? 'failed' : 'ready', retry };
    }
    if (!libraryEnabled || scopeKey === null) return { definition: null, title: null, status: 'failed', retry };
    if (reference?.kind === 'plugin') {
        return { definition: plugin.source?.definition ?? null, title: plugin.source?.title ?? null,
            status: plugin.status === 'ready' ? 'ready' : plugin.status === 'loading' ? 'loading' : 'failed', retry: plugin.retry };
    }
    if (reference === null) return { definition: null, title: null, status: 'failed', retry };
    const current = read?.ref === artifactId && read.scopeKey === scopeKey && read.lifetime.isCurrent() ? read : null;
    return { definition: current?.definition ?? null, title: current?.title ?? null,
        status: current === null ? 'loading' : current.failed ? 'failed' : 'ready', retry };
}
