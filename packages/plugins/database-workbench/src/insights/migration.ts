import type { DatabaseTaskEvidenceV1 } from '@happier-dev/database-protocol';
import type { SessionInputHandoffInputV1 } from '@happier-dev/plugin-sdk/sessions';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import type { WorkbenchControlBinding } from '../ui/models.js';
import { buildDatabaseFindingBriefV1 } from './brief.js';

export type DatabaseMigrationTask = Extract<DatabaseTaskEvidenceV1, { kind: 'setup' | 'connection' | 'migration' }>
    & Readonly<{ kind: 'migration' }>;

/** The existing Session Action owns destination, editable composition, admission and delivery.
 * This adapter contributes only the domain brief and the person's existing press identity. */
export function createDatabaseMigrationHandoffControl(options: Readonly<{
    task: DatabaseMigrationTask;
    handoff: Omit<SessionInputHandoffInputV1, 'input' | 'idempotencyKey'>;
    idempotencyKey(): string;
    onSettled?(execution: PluginUiActionControlExecution): void;
}>): WorkbenchControlBinding {
    return {
        action: 'session.input.handoff',
        controller: {
            prepare({ signal }) {
                if (signal.aborted) return null;
                const brief = buildDatabaseFindingBriefV1(options.task);
                const input: SessionInputHandoffInputV1 = { ...options.handoff,
                    input: { text: brief.text, forgeEvidence: brief.evidence },
                    idempotencyKey: options.idempotencyKey() };
                return { input: projectNativeJsonValueForTransport(input) };
            },
            onSettled(execution) { options.onSettled?.(execution); },
        },
    };
}
