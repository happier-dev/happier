import { it, expect } from 'vitest';
import { DeploySuggestionCatalogV1Schema, DeploySuggestionInputV1Schema, DeploySuggestionV1Schema, validateDeploySuggestionV1, renderDeployPlanBriefV1 } from './deploySuggestionsV1.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import type { DeploySuggestionRecommendationV1 } from './deploySuggestionsV1.js';
import { DEPLOYMENT_VALIDATION_RULES_V1, DEPLOY_BUILD_PREVIEW_RULES_V1, DEPLOY_BUILD_PREVIEW_OWN_SERVER_RULES_V1 } from '../deploymentValidationV1.js';
import { DeploymentEnvironmentCreateActionInputV1Schema } from '../deploymentActionsV1.js';
import { validateExecutionRunProfileResult } from '../../execution/runs/resultContract.js';
import { normalizePluginJsonSchema } from '../../plugins/actions/protocolComposableSchema.js';
const catalog = DeploySuggestionCatalogV1Schema.parse({
    starters: [{ id: 'static', title: 'Static', deploy: { framework: 'html', output: 'static' } }],
    apps: [{ id: 'analytics', title: 'Analytics' }],
    targets: [
        { id: 'pages', title: 'Pages', targetClass: 'platform', availability: 'available', accepts: ['static'], needs: ['repository'], sources: { gitIntegration: ['github'], upload: false } },
        { id: 'workers', title: 'Workers', targetClass: 'platform', availability: 'available', accepts: ['workers'], needs: ['stateless'] },
        { id: 'own', title: 'Own server', targetClass: 'ownServer', availability: 'available', accepts: ['compose'], needs: [] },
    ], machines: [], stores: [], forges: [{ providerKind: 'github', title: 'GitHub' }],
});
const recommendation = { source: { kind: 'starter', starterId: 'static' }, targetId: 'pages',
    whatToBuild: 'A bakery website', stack: { framework: 'html', output: 'static' }, data: { kind: 'none' }, variables: [] } satisfies DeploySuggestionRecommendationV1;
it('passes valid recommendations unchanged, drops unknown ids, incompatible pairs, price fields and missing fields', () => {
    const result = validateDeploySuggestionV1({ recommendations: [recommendation,
        { ...recommendation, targetId: 'invented' }, { ...recommendation, targetId: 'workers' },
        { ...recommendation, price: '$0' }, { source: recommendation.source },
        { ...recommendation, whatToBuild: 'A bakery website for $20/month' }], questions: null }, catalog);
    expect(result.recommendations).toEqual([recommendation]);
    expect(result.dropped.map(row => row.index)).toEqual([1, 2, 3, 4, 5]);
});
it('drops numeric CAD and dollar-word prices while preserving technical version text', () => {
    const technical = { ...recommendation, whatToBuild: 'A CAD 3D viewer with CSS 3 and React 20' };
    const result = validateDeploySuggestionV1({ recommendations: [technical,
        { ...recommendation, whatToBuild: 'A bakery website for CAD 20 per month' },
        { ...recommendation, whatToBuild: 'A bakery website for 20 dollars per month' }], questions: null }, catalog);
    expect(result).toEqual({ recommendations: [technical], dropped: [
        { index: 1, reason: 'invalid_recommendation' }, { index: 2, reason: 'invalid_recommendation' },
    ], questions: null, droppedQuestions: [] });
});
it('rejects variable values before a description reaches a run', () => {
    const input = { description: 'Bakery', catalog, variables: [{ key: 'API_KEY', secret: true }] };
    expect(DeploySuggestionInputV1Schema.safeParse(input).success).toBe(true);
    expect(DeploySuggestionInputV1Schema.safeParse({ ...input, variables: [{ key: 'API_KEY', secret: true, value: 'secret' }] }).success).toBe(false);
});
it.each(['starter', 'scratch'] as const)('preserves description bytes and carries the %s plan into the build Session', (kind) => {
    const description = '  Bäckerei 🥐\r\n\n';
    const plan = { ...recommendation, source: kind === 'starter' ? recommendation.source : { kind },
        data: { kind: 'store', storeId: 'db', engine: 'postgres' }, variables: [{ key: 'DATABASE_URL', secret: true }] } satisfies DeploySuggestionRecommendationV1;
    const brief = renderDeployPlanBriefV1(description, plan);
    expect(brief.startsWith(description)).toBe(true);
    expect(brief.slice(description.length)).toContain(JSON.stringify(plan));
    expect(brief).toContain('projects.script.run');
    expect(brief).toContain('deployments.health.current');
    expect(brief).toContain('Do not provision, bind secrets, merge, or deploy Production.');
    expect(brief.split(DEPLOYMENT_VALIDATION_RULES_V1)).toHaveLength(2);
    const repository = { providerKind: 'github' as const, owner: 'alice', name: 'bakery', visibility: 'private' as const };
    expect(renderDeployPlanBriefV1(description, plan, repository)).toContain(JSON.stringify(repository));
});
it('shows the build Session a preview Environment create the Action admits (AUTO-LIVE p4: purpose preview, no Project, no definition)', () => {
    const brief = renderDeployPlanBriefV1('Bakery', { ...recommendation, targetId: 'own' }, undefined, { targetClass: 'ownServer' });
    const shown = brief.split('```json\n').slice(1).map(block => JSON.parse(block.slice(0, block.indexOf('\n```'))) as unknown)
        .find(block => typeof block === 'object' && block !== null && 'controllerMachineId' in block);
    expect(shown, brief).toBeDefined();
    const admitted = DeploymentEnvironmentCreateActionInputV1Schema.safeParse(shown);
    expect(admitted.error?.issues ?? null).toBeNull();
    expect(shown).toMatchObject({ protection: 'nonProduction', purpose: 'standard' });
    // Own server deploys the repository's Compose file; the rule that has the agent author one rides in every brief, once.
    expect(brief.split(DEPLOY_BUILD_PREVIEW_RULES_V1)).toHaveLength(2);
    expect(shown).toMatchObject({ definition: { from: 'repository', compose: { path: 'compose.yaml' } } });
});
it('scopes the Compose and own-server input to an Own server target; a platform brief carries neither (REVIEW-DELTA4 F1)', () => {
    const own = renderDeployPlanBriefV1('Bakery', { ...recommendation, targetId: 'own' }, undefined, { targetClass: 'ownServer' });
    const platform = renderDeployPlanBriefV1('Bakery', recommendation, undefined, { targetClass: 'platform' });
    expect(own.split(DEPLOY_BUILD_PREVIEW_OWN_SERVER_RULES_V1)).toHaveLength(2);
    expect(platform).not.toContain(DEPLOY_BUILD_PREVIEW_OWN_SERVER_RULES_V1);
    expect(platform).not.toContain('compose');
    expect(platform).not.toContain('installationId');
    expect(platform.split(DEPLOY_BUILD_PREVIEW_RULES_V1)).toHaveLength(2);
});
it('the run contract and the check agree on which single-choice bounds only restate it (REVIEW-DELTA4 F2)', () => {
    const contract = { kind: 'json' as const, schema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(DeploySuggestionV1Schema, { target: 'draft-7' })) };
    const [first] = liveQuestions.questions;
    const { minSelections: _min, maxSelections: _max, ...bare } = first;
    for (const bounds of [{}, { minSelections: 0 }, { minSelections: 1 }, { maxSelections: 1 }, { minSelections: 0, maxSelections: 1 },
        { minSelections: -1 }, { minSelections: 0.5 }, { minSelections: 2 }, { maxSelections: 0 }, { maxSelections: 2 }]) {
        const questions = { ...liveQuestions, questions: [{ ...bare, ...bounds }] };
        const run = validateExecutionRunProfileResult({ recommendations: [], questions }, contract).ok;
        const kept = validateDeploySuggestionV1({ recommendations: [], questions }, catalog).droppedQuestions.length === 0;
        expect([JSON.stringify(bounds), run], 'run contract').toEqual([JSON.stringify(bounds), kept]);
    }
});
it('routes catalog apps only to a declared Compose host', () => {
    const app = { ...recommendation, source: { kind: 'catalogApp', appId: 'analytics' }, targetId: 'own' };
    expect(validateDeploySuggestionV1({ recommendations: [app, { ...app, targetId: 'pages' }] }, catalog).recommendations).toEqual([app]);
});

it('checks the selected forge against registry publication and declared target source routes', () => {
    const declared = { ...catalog, targets: catalog.targets.map(target => ({ ...target,
        sources: { gitIntegration: ['github'], upload: false } })) };
    const selected = { ...recommendation, repositoryProviderKind: 'github' };
    expect(validateDeploySuggestionV1({ recommendations: [selected] }, declared).recommendations).toEqual([selected]);
    expect(validateDeploySuggestionV1({ recommendations: [selected] }, { ...declared, forges: [] }).recommendations).toEqual([]);
    expect(validateDeploySuggestionV1({ recommendations: [selected] }, { ...declared,
        targets: declared.targets.map(target => ({ ...target, sources: { gitIntegration: [], upload: true } })) }).recommendations).toEqual([]);
});

it('admits a setup served by another publishing forge before a repository provider is chosen', () => {
    const gitlab = { ...catalog, forges: [{ providerKind: 'gitlab', title: 'GitLab' }],
        targets: catalog.targets.map(target => ({ ...target, sources: { gitIntegration: ['gitlab'], upload: false } })) };
    expect(validateDeploySuggestionV1({ recommendations: [recommendation] }, gitlab).recommendations).toEqual([recommendation]);
    expect(validateDeploySuggestionV1({ recommendations: [recommendation] }, { ...gitlab, forges: [] }).recommendations).toEqual([]);
});

// run_4e61a18e-59f9-4999-ab60-3025c6f86fa2 (AUTO-LIVE F-QUESTIONS): the model's single-choice questions carried
// redundant selection bounds, which the shared question schema refuses; the whole round was dropped silently.
const liveQuestions = { kind: 'questions', title: 'Contact form handling', questions: [
    { id: 'contact_handling', prompt: 'How should contact form submissions be handled?', description: 'Static starter has no backend; choose handling for form submissions',
        type: 'singleChoice', required: true, allowCustom: true, allowNote: false, minSelections: 0, maxSelections: 1, choices: [
            { id: 'mailto_only', label: 'mailto only', description: 'Use mailto link only, no backend storage' },
            { id: 'external_form_service', label: 'External form service', description: 'Wire form to an external service you provide later' },
            { id: 'decide_later', label: 'Decide later', description: 'Build UI now, decide handling later' }] },
    { id: 'repo_provider', prompt: 'Which repository provider should hold the Session code?', description: 'Choose code host for the new starter code',
        type: 'singleChoice', required: true, allowCustom: false, allowNote: false, minSelections: 0, maxSelections: 1, choices: [
            { id: 'github', label: 'GitHub', description: 'Use GitHub forge' }, { id: 'gitlab', label: 'GitLab', description: 'Use GitLab forge' }] },
] };
it('keeps single-choice questions whose selection bounds only restate single choice', () => {
    const result = validateDeploySuggestionV1({ recommendations: [], questions: liveQuestions }, catalog);
    expect(result.questions?.questions.map(question => question.id)).toEqual(['contact_handling', 'repo_provider']);
    expect(result.questions?.questions[0]).not.toHaveProperty('minSelections');
    expect(result.questions?.questions[0]).not.toHaveProperty('maxSelections');
    expect(result.droppedQuestions).toEqual([]);
});
it('drops a question the shared schema still refuses, with a typed reason, and keeps the rest', () => {
    const [first, second] = liveQuestions.questions;
    const result = validateDeploySuggestionV1({ recommendations: [], questions: { ...liveQuestions,
        questions: [{ ...first, maxSelections: 2 }, second] } }, catalog);
    expect(result.questions?.questions.map(question => question.id)).toEqual(['repo_provider']);
    expect(result.droppedQuestions).toEqual([{ index: 0, reason: 'invalid_question' }]);
    expect(validateDeploySuggestionV1({ recommendations: [], questions: { kind: 'questions', questions: 'none' } }, catalog))
        .toMatchObject({ questions: null, droppedQuestions: [{ reason: 'invalid_questions' }] });
});
it('the run\u2019s result contract admits the live model answer the check normalizes: single choice may restate its bounds, nothing more (AUTO-LIVE p4 invalid_output)', () => {
    // What suggestDeploySetup sends as resultSchema and the task profile enforces before the check ever sees the answer.
    const contract = { kind: 'json' as const, schema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(DeploySuggestionV1Schema, { target: 'draft-7' })) };
    expect(validateExecutionRunProfileResult({ recommendations: [recommendation], questions: liveQuestions }, contract))
        .toMatchObject({ ok: true });
    const [first, second] = liveQuestions.questions;
    expect(validateExecutionRunProfileResult({ recommendations: [], questions: { ...liveQuestions,
        questions: [{ ...first, maxSelections: 2 }, second] } }, contract)).toMatchObject({ ok: false, reason: 'schema_mismatch' });
    expect(validateExecutionRunProfileResult({ recommendations: [], questions: { ...liveQuestions,
        questions: [{ ...second, type: 'multipleChoice', minSelections: 1, maxSelections: 3 }] } }, contract)).toMatchObject({ ok: true });
});
