import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { deleteAutomationDefinition, listAutomationDefinitions, reconcileAutomationDefinition, runAutomationNowReceipt } from './automations';
import { normalizeWorkflowActionThrownError } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { runWithServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { AutomationDefinitionListRequestSchema, AutomationDefinitionListResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';

describe('Automation HTTP transport', () => {
  it('reads an attached Action trigger page instead of the ordinary Account inventory', async () => {
    const server = Fastify();
    const selection = { actionId: 'projects.sources.read', phase: 'after' as const, limit: 20, cursor: 'previous-page' };
    const attachedPage = AutomationDefinitionListResponseSchema.parse({
      automations: [], attached: [], skippedNotSharedCount: 2, nextCursor: 'next-page',
    });
    const requests: string[] = [];
    server.addHook('onRequest', async request => { requests.push(`${request.method} ${request.url}`); });
    server.get('/v3/automations', async () => ({ automations: [], nextCursor: null }));
    server.post('/v3/automations/query', async request => {
      const query = AutomationDefinitionListRequestSchema.parse(request.body);
      expect(query).toEqual(selection);
      expect(request.headers.authorization).toBe('Bearer test-token');
      return attachedPage;
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      await expect(runWithServerHttpBaseUrl(address, () => listAutomationDefinitions({ token: 'test-token' })))
        .resolves.toEqual({ automations: [], nextCursor: null });
      await expect(runWithServerHttpBaseUrl(address, () => listAutomationDefinitions({ token: 'test-token', ...selection })))
        .resolves.toEqual(attachedPage);
      expect(requests).toEqual(['GET /v3/automations?limit=100', 'POST /v3/automations/query']);
    } finally { await server.close(); }
  });

  it('retains a confirmed transaction rollback instead of reporting an uncertain definition write', async () => {
    const server = Fastify();
    server.put('/v3/automations/:id', async (_request, reply) => reply.code(503).send({
      error: 'database_transaction_conflict_exhausted', statusCode: 503,
    }));
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      await expect(runWithServerHttpBaseUrl(address, () => reconcileAutomationDefinition({ token: 'test-token', automationId: 'team-schedule',
        input: { expectedTemplateVersion: 8, name: 'Team schedule', description: null, enabled: true,
          assignments: [], triggers: [], removedTriggers: [] } }))).rejects.toMatchObject({ code: 'database_transaction_conflict_exhausted' });
    } finally { await server.close(); }
  });
  it('retains an unresolved receipt after a real HTTP handler admits an occurrence then fails its response', async () => {
    const server = Fastify();
    const admitted = new Set<string>();
    server.post('/v3/automations/:id/run-now', async request => {
      admitted.add(String(request.headers['idempotency-key']));
      throw new Error('receipt projection failed');
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const result = await runWithServerHttpBaseUrl(address, () => runAutomationNowReceipt({ token: 'test-token',
        automationId: 'trigger-set', idempotencyKey: 'same-occurrence' })).catch(normalizeWorkflowActionThrownError);
      expect(result).toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
      expect([...admitted]).toEqual(['same-occurrence']);
    } finally { await server.close(); }
  });
  it('deletes through a real JSON-parsing HTTP boundary without an empty JSON body', async () => {
    const server = Fastify();
    let deleted = false;
    server.delete('/v3/automations/:id', async () => { deleted = true; return { ok: true, removedRevision: 2 }; });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      await expect(runWithServerHttpBaseUrl(address, () => deleteAutomationDefinition({ token: 'test-token', automationId: 'empty-set' })))
        .resolves.toEqual({ ok: true, removedRevision: 2 });
      expect(deleted).toBe(true);
    } finally { await server.close(); }
  });
});
