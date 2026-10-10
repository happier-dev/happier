import type * as React from 'react';

/**
 * One role as a picker shows it. Display-ready: the connected catalog owner resolves the role
 * (through `resolveRoleSelectionV1`) and its engine identity before a row ever renders, so the
 * rail itself makes no role decision.
 */
export type RoleRailItem = Readonly<{
    roleId: string;
    name: string;
    /** The first line of the role's instructions: what it is for. */
    purpose: string;
    /** "Opus 5.5 · High"; absent when the role follows the default agent. */
    engineLabel?: string;
    engineIcon?: React.ReactNode;
    /** The Agent the role's engine names; a caller compares it with the running one. */
    agentTargetKey?: string;
    /**
     * Why the role cannot be chosen as it stands: its engine names an Agent this Account has not
     * enabled (`engine`: choose an engine), or no layer resolves it any more (`role`: removed, or no
     * longer shared). The rail keeps such a role in its place and says so instead of dropping it.
     */
    unavailable?: 'engine' | 'role';
}>;
