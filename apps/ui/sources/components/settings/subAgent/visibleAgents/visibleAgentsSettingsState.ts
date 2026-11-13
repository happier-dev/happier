import {
    VisibleAgentsV1Schema,
    resolveVisibleAgentsV1,
    type VisibleAgentsTeamTemplateEntryV1,
    type VisibleAgentsV1,
} from '@happier-dev/protocol';

export function parseVisibleAgentsSettingV1(raw: unknown): VisibleAgentsV1 {
    return resolveVisibleAgentsV1({ visibleAgentsV1: raw });
}

export function updateVisibleAgentsAssemblyEnabledV1(raw: unknown, enabled: boolean): VisibleAgentsV1 {
    const current = parseVisibleAgentsSettingV1(raw);
    return VisibleAgentsV1Schema.parse({ ...current, assembleTeamOnLeadAssignment: enabled });
}

export function updateVisibleAgentsTeamTemplateV1(
    raw: unknown,
    teamTemplate: ReadonlyArray<VisibleAgentsTeamTemplateEntryV1>,
): VisibleAgentsV1 {
    const current = parseVisibleAgentsSettingV1(raw);
    return VisibleAgentsV1Schema.parse({ ...current, teamTemplate: [...teamTemplate] });
}
