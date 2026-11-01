import type { HttpRequest, HttpResponse } from './contracts.js';

/** Host-only projection: never add URLs, arbitrary headers or request/response content. */
export type PluginHttpTraceDiagnostic = {
    pluginId?: string;
    operationId?: string;
    method?: string;
    routeTemplate?: string;
    httpStatus?: number;
    rateLimitRemaining?: string;
    rateLimitReset?: string;
    rateLimitResource?: string;
};

// Return only literals from these shapes, never captured path values. Unknown
// routes (including other API hosts) retain topology with every segment hidden.
const GITHUB_ROUTE_TEMPLATES = [
    '/graphql', '/user', '/rate_limit', '/search/issues', '/search/code', '/search/repositories',
    '/repos/{owner}/{repo}',
    '/repos/{owner}/{repo}/pulls', '/repos/{owner}/{repo}/pulls/{number}',
    '/repos/{owner}/{repo}/pulls/{number}/files', '/repos/{owner}/{repo}/pulls/{number}/reviews',
    '/repos/{owner}/{repo}/pulls/{number}/comments', '/repos/{owner}/{repo}/pulls/{number}/commits',
    '/repos/{owner}/{repo}/issues', '/repos/{owner}/{repo}/issues/{number}',
    '/repos/{owner}/{repo}/issues/{number}/comments',
    '/repos/{owner}/{repo}/actions/runs', '/repos/{owner}/{repo}/actions/runs/{run_id}',
    '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
    '/repos/{owner}/{repo}/commits/{ref}/check-runs', '/repos/{owner}/{repo}/commits/{ref}/status',
].map(template => ({ template, segments: template.slice(1).split('/') }));

function routeTemplate(rawUrl: string): string {
    const url = new URL(rawUrl);
    const segments = url.pathname.slice(1).split('/');
    if (url.hostname === 'api.github.com') {
        const known = GITHUB_ROUTE_TEMPLATES.find(candidate => candidate.segments.length === segments.length
            && candidate.segments.every((segment, index) => segment.startsWith('{') || segment === segments[index]));
        if (known) return known.template;
    }
    return url.pathname === '/' ? '/' : segments.map(() => '/{segment}').join('');
}

export function createPluginHttpTraceDiagnostic(input: Readonly<{
    pluginId?: string | null;
    operationId?: string;
    request: Pick<HttpRequest, 'url' | 'method'>;
}>): PluginHttpTraceDiagnostic {
    return {
        ...(input.pluginId ? { pluginId: input.pluginId } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        method: (input.request.method ?? 'GET').trim().toUpperCase(),
        routeTemplate: routeTemplate(input.request.url),
    };
}

export function recordPluginHttpTraceResponse(diagnostic: PluginHttpTraceDiagnostic, response: Pick<HttpResponse, 'status' | 'headers'>): void {
    diagnostic.httpStatus = response.status;
    for (const [name, value] of Object.entries(response.headers)) {
        // Only these provider quota facts cross the diagnostic boundary. Invalid
        // values cannot smuggle arbitrary response content into the file sink.
        switch (name.toLowerCase()) {
            case 'x-ratelimit-remaining':
                if (/^\d+$/.test(value)) diagnostic.rateLimitRemaining = value;
                break;
            case 'x-ratelimit-reset':
                if (/^\d+$/.test(value)) diagnostic.rateLimitReset = value;
                break;
            case 'x-ratelimit-resource':
                if (['core', 'search', 'graphql', 'integration_manifest', 'code_search',
                    'actions_runner_registration', 'source_import', 'code_scanning_upload',
                    'scim', 'dependency_snapshots', 'audit_log', 'audit_log_streaming'].includes(value)) {
                    diagnostic.rateLimitResource = value;
                }
                break;
        }
    }
}
