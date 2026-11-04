import type { SessionListGroupingMode } from './sessionListLayout';

type SessionListGroupingModeParams = Readonly<{ layoutV1?: 'projects' | 'recent_activity' }>;

/** The scalar layout is the only runtime grouping decision. */
export function resolveSessionListGroupingMode(params: SessionListGroupingModeParams): SessionListGroupingMode {
    return params.layoutV1 === 'recent_activity' ? 'date' : 'project';
}

export function usesProjectGroupingInSessionList(params: SessionListGroupingModeParams): boolean {
    return resolveSessionListGroupingMode(params) === 'project';
}
