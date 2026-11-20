import { numericId } from '../api.js';

export function buildJiraCreationPlaceId(projectId: string, issueTypeId: string): string {
    return `${projectId}/${issueTypeId}`;
}

export function parseJiraCreationPlaceId(placeId: string): { projectId: string; issueTypeId: string } | null {
    const [projectId, issueTypeId, extra] = placeId.split('/');
    if (!numericId(projectId) || !numericId(issueTypeId) || extra !== undefined) return null;
    return { projectId, issueTypeId };
}
