import type { Disposable, JsonValue } from '@happier-dev/plugin-sdk';
import type {
    ScopedSettingsService,
    SettingDescriptor,
    SettingsChange,
    SettingsMutationResult,
    SettingsSnapshot,
} from '@happier-dev/plugin-sdk/settings';

/**
 * One in-memory Account Settings record.
 *
 * Settings is a genuine host persistence boundary, so it is the one thing these
 * tests stand in for. Everything beneath it — parsing, bounds, identity,
 * selection and the CAS decision — is the real implementation.
 *
 * The revision is record-wide, exactly as the real Account Settings record is:
 * a stale `expectedRevision` is rejected even when the competing writer touched
 * a different key, which is what makes a conflict test meaningful.
 */

export type TestkitAccountSettings = Readonly<{
    settings: ScopedSettingsService;
    /** Write as a competing client would, bypassing the owner under test. */
    seed(id: string, value: JsonValue): void;
    /**
     * Land one competing write between the owner's read and its next write, so
     * the CAS decision is exercised the way another device actually causes it.
     */
    armConcurrentWrite(id: string, value: JsonValue): void;
    read(id: string): JsonValue | undefined;
    revision(): string;
    setCallCount(): number;
    rejectedExpectedRevisions(): readonly (string | undefined)[];
}>;

export function createTestkitAccountSettings(
    initial: Readonly<Record<string, JsonValue>> = {},
): TestkitAccountSettings {
    const values = new Map<string, JsonValue>(Object.entries(initial));
    let revisionCounter = 1;
    let setCalls = 0;
    const rejected: (string | undefined)[] = [];
    let armed: Readonly<{ id: string; value: JsonValue }> | null = null;

    const currentRevision = (): string => `revision-${revisionCounter}`;

    const snapshot = (): SettingsSnapshot => Object.freeze({
        scope: { kind: 'account' } as const,
        revision: currentRevision(),
        values: Object.freeze(Object.fromEntries(values)),
    });

    const settings: ScopedSettingsService = {
        async snapshot() {
            return snapshot();
        },
        async get<T extends JsonValue = JsonValue>(id: string) {
            const value = values.get(id);
            return (value === undefined ? null : value) as T | null;
        },
        async set(id, value, options): Promise<SettingsMutationResult> {
            setCalls += 1;
            if (armed) {
                values.set(armed.id, armed.value);
                revisionCounter += 1;
                armed = null;
            }
            if (options?.expectedRevision !== undefined && options.expectedRevision !== currentRevision()) {
                rejected.push(options.expectedRevision);
                throw new Error('settings_revision_mismatch');
            }
            values.set(id, value);
            revisionCounter += 1;
            return { scope: { kind: 'account' }, revision: currentRevision() };
        },
        async reset(id): Promise<SettingsMutationResult> {
            values.delete(id);
            revisionCounter += 1;
            return { scope: { kind: 'account' }, revision: currentRevision() };
        },
        describe(): readonly SettingDescriptor[] {
            return [];
        },
        watch(_listener: (change: SettingsChange) => void): Disposable {
            return { dispose() { /* nothing to release */ } };
        },
    };

    return {
        settings,
        seed(id, value) {
            values.set(id, value);
            revisionCounter += 1;
        },
        armConcurrentWrite(id, value) {
            armed = { id, value };
        },
        read(id) {
            return values.get(id);
        },
        revision: currentRevision,
        setCallCount: () => setCalls,
        rejectedExpectedRevisions: () => [...rejected],
    };
}
