import * as React from 'react';
import { parseWorkflowDefinitionRefV1, resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useWorkflowPluginSource } from '../library/workflowLibraryReads';

/** Accessible definition content, shared by child bindings and trigger inputs. Saved/shared
 * references always use Get: list metadata is not content-disclosure authority. */
export function useWorkflowReferenceDefinition(ref: string | null, libraryEnabled = true): Readonly<{
    definition: WorkflowDefinitionV1 | null;
    status: 'idle' | 'loading' | 'failed' | 'ready';
    retry: () => void;
}> {
    const scope = useActiveServerAccountScope();
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const reference = parseWorkflowDefinitionRefV1(ref);
    const plugin = useWorkflowPluginSource(reference?.kind === 'plugin' ? ref : null, libraryEnabled);
    const artifactId = reference?.kind === 'artifact' ? reference.artifactId : null;
    const [attempt, setAttempt] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{
        ref: string; scopeKey: string; definition: WorkflowDefinitionV1 | null; failed: boolean;
        lifetime: ActiveServerAccountScopeLifetime;
    }> | null>(null);
    React.useEffect(() => {
        if (!libraryEnabled || artifactId === null || scopeKey === null) return;
        const controller = new AbortController();
        const lifetime = captureActiveServerAccountScopeLifetime();
        setRead(null);
        void getWorkflowDefinition({ definitionId: artifactId, signal: controller.signal }).then((result) => {
            if (!controller.signal.aborted && lifetime?.isCurrent()) {
                setRead({ ref: artifactId, scopeKey, definition: result.definition, failed: false, lifetime });
            }
        }).catch(() => {
            if (!controller.signal.aborted && lifetime?.isCurrent()) {
                setRead({ ref: artifactId, scopeKey, definition: null, failed: true, lifetime });
            }
        });
        return () => controller.abort();
    }, [artifactId, attempt, libraryEnabled, scopeKey]);
    const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
    if (ref === null) return { definition: null, status: 'idle', retry };
    if (reference?.kind === 'builtin') {
        const definition = resolveBuiltinWorkflowDefinitionV1(reference.id)?.definition ?? null;
        return { definition, status: definition === null ? 'failed' : 'ready', retry };
    }
    if (!libraryEnabled || scopeKey === null) return { definition: null, status: 'failed', retry };
    if (reference?.kind === 'plugin') {
        return { definition: plugin.source?.definition ?? null,
            status: plugin.status === 'ready' ? 'ready' : plugin.status === 'loading' ? 'loading' : 'failed', retry: plugin.retry };
    }
    if (reference === null) return { definition: null, status: 'failed', retry };
    const current = read?.ref === artifactId && read.scopeKey === scopeKey && read.lifetime.isCurrent() ? read : null;
    return { definition: current?.definition ?? null,
        status: current === null ? 'loading' : current.failed ? 'failed' : 'ready', retry };
}
