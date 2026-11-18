import type * as React from 'react';

/** Controlled data for the shared Send to chip; inventories and persistence stay caller-owned. */
export type RecipientMultiSelectTarget<T> = Readonly<{
    id: string;
    label: string;
    recipient: T;
    /** One quiet line under the name (a session's agent and Machine). */
    subtitle?: string;
    /** The recipient's mark in the row's leading slot (an agent mark). */
    icon?: React.ReactNode;
}>;
/** A recipient the composer cannot reach, listed after the others with why (bulk compose skips). */
export type RecipientMultiSelectSkipped = Readonly<{ id: string; label: string; reason: string; icon?: React.ReactNode }>;
export type RecipientMultiSelectModel<T> = Readonly<{
    targets: readonly RecipientMultiSelectTarget<T>[];
    skipped?: readonly RecipientMultiSelectSkipped[];
    /** Replaces the names on the chip when a count reads better ("To: 6 sessions · 1 skipped"). */
    summaryLabel?: string;
    selectedIds: readonly string[];
    selectedRecipients: readonly T[];
    removedRecipients: readonly T[];
    toggle(id: string): void;
    clear(): void;
}>;

export function buildRecipientMultiSelectModel<T>(input: Readonly<{
    targets: readonly RecipientMultiSelectTarget<T>[];
    recipients: readonly T[];
    key(recipient: T): string;
    onChange(recipients: readonly T[]): void;
}>): RecipientMultiSelectModel<T> {
    const selected = new Set(input.recipients.map(input.key));
    const admitted = new Set(input.targets.map(target => input.key(target.recipient)));
    const selectedRecipients = input.recipients.filter(recipient => admitted.has(input.key(recipient)));
    return {
        targets: input.targets,
        selectedIds: input.targets.filter(target => selected.has(input.key(target.recipient))).map(target => target.id),
        selectedRecipients,
        removedRecipients: input.recipients.filter(recipient => !admitted.has(input.key(recipient))),
        toggle(id) {
            const target = input.targets.find(candidate => candidate.id === id);
            if (!target) return;
            const key = input.key(target.recipient);
            input.onChange(selected.has(key)
                ? selectedRecipients.filter(recipient => input.key(recipient) !== key)
                : [...selectedRecipients, target.recipient]);
        },
        clear: () => input.onChange([]),
    };
}
