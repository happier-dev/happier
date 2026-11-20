import type { DatabaseTaskEvidenceV1 } from '@happier-dev/plugin-sdk/database';
import type { SessionInputHandoffInputV1, SessionInputForgeEvidenceV1 } from '@happier-dev/plugin-sdk/sessions';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import type { WorkbenchControlBinding } from '../ui/models.js';
import { buildDatabaseFindingBriefV1 } from './brief.js';

export type DatabaseMigrationTask = Extract<DatabaseTaskEvidenceV1, { kind: 'setup' | 'connection' | 'migration' }>
    & Readonly<{ kind: 'migration' }>;

type HandoffOptions = Readonly<{
    handoff: Omit<SessionInputHandoffInputV1, 'input' | 'idempotencyKey'>;
    idempotencyKey(): string;
    onSettled?(execution: PluginUiActionControlExecution): void;
}>;

/** The Session Action owns destination, editable composition, admission and delivery. */
export function createDatabaseBriefHandoffControl(
    brief: () => Readonly<{ text: string; evidence: SessionInputForgeEvidenceV1 }>,
    options: HandoffOptions,
): WorkbenchControlBinding {
    return {
        action: 'session.input.handoff',
        controller: {
            prepare({ signal }) {
                if (signal.aborted) return null;
                const { text, evidence } = brief();
                const input: SessionInputHandoffInputV1 = { ...options.handoff,
                    input: { text, forgeEvidence: evidence },
                    idempotencyKey: options.idempotencyKey() };
                return { input: projectNativeJsonValueForTransport(input) };
            },
            onSettled(execution) { options.onSettled?.(execution); },
        },
    };
}

export function createDatabaseMigrationHandoffControl(
    options: HandoffOptions & Readonly<{ task: DatabaseMigrationTask }>,
): WorkbenchControlBinding {
    return createDatabaseBriefHandoffControl(() => buildDatabaseFindingBriefV1(options.task), options);
}
