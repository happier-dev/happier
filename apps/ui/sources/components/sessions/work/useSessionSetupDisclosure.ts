import * as React from 'react';
import { sessionInfoDisclosuresState, useSessionInfoSectionExpanded } from '@/sync/domains/state/disclosureUiState';
import type { WorkSectionSetupDisclosure } from './WorkSection';

/**
 * The Setup rows share this device disclosure state; mounting never writes it. Each row publishes its own
 * expand/collapse command with the state it shows (`WorkSectionAsSetupRow`).
 */
export function useSessionSetupDisclosure(): WorkSectionSetupDisclosure {
    const instructions = useSessionInfoSectionExpanded('instructions');
    const memory = useSessionInfoSectionExpanded('memory');
    const context = useSessionInfoSectionExpanded('context');
    const voice = useSessionInfoSectionExpanded('voice');
    const roles = useSessionInfoSectionExpanded('roles');
    const notes = useSessionInfoSectionExpanded('notes');
    const about = useSessionInfoSectionExpanded('about');
    return React.useMemo(() => {
        const remembered: Readonly<Record<string, boolean | undefined>> = { instructions, memory, context, voice, roles, notes, about };
        return {
            isExpanded: (key: string, sectionDefault?: boolean) =>
                remembered[key] ?? sectionDefault ?? key === 'instructions',
            setExpanded: (key: string, expanded: boolean) => {
                sessionInfoDisclosuresState.set(key, expanded);
            },
        };
    }, [instructions, memory, context, voice, roles, notes, about]);
}
