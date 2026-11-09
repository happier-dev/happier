import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';

export type SessionInfoDisclosureCommand = Readonly<{
    /** Stable within this mounted Info body, e.g. `about` or `add-to-session`. */
    key: string;
    title: string;
    expanded: boolean;
    /** The rendered disclosure's same state owner, not another copy of its state. */
    onExpandedChange(expanded: boolean): void;
    available?: boolean;
}>;

/** Passive command declarations: no reads, mount-time writes, or independent lifetime. */
export function useSessionInfoDisclosureCommands(
    disclosures: readonly SessionInfoDisclosureCommand[],
): ReturnType<typeof useCurrentUiContextLocalCommands> {
    return useCurrentUiContextLocalCommands(disclosures.flatMap(disclosure => {
        if (disclosure.available === false) return [];
        const operation = disclosure.expanded ? 'collapse' : 'expand';
        return [{
            key: `session.info.${disclosure.key}.${operation}`,
            title: `${t(`common.${operation}`)} · ${disclosure.title}`,
            invoke: () => disclosure.onExpandedChange(!disclosure.expanded),
        }];
    }));
}
