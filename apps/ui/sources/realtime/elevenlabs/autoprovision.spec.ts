import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ElevenLabs BYO autoprov', () => {
  const originalFetch = globalThis.fetch;

  function fetchMock() {
    return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  }

  function okJson(payload: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }

  function errorResponse(status: number, text = 'error'): Response {
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => text,
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates an agent using existing client tools when available', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: [
            { id: 'tool_message', tool_config: { type: 'client', name: 'messageClaudeCode', description: '' } },
            { id: 'tool_permission', tool_config: { type: 'client', name: 'processPermissionRequest', description: '' } },
          ],
        }),
      )
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    const result = await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    expect(result.agentId).toBe('agent_1');

    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(fetchMock().mock.calls[0]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/convai/agents/create');

    const body = JSON.parse(fetchMock().mock.calls[1]?.[1]?.body);
    expect(body.conversation_config.agent.prompt.tool_ids).toEqual(['tool_message', 'tool_permission']);
    expect(body.conversation_config.agent.prompt.prompt).toContain('{{initialConversationContext}}');
  });

  it('creates missing client tools before creating the agent', async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ tools: [] }))
      .mockResolvedValueOnce(okJson({ id: 'tool_message' }))
      .mockResolvedValueOnce(okJson({ id: 'tool_permission' }))
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    const result = await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    expect(result.agentId).toBe('agent_1');

    expect(fetchMock()).toHaveBeenCalledTimes(4);
    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[2]?.[0]).toContain('/v1/convai/tools');
    expect(fetchMock().mock.calls[3]?.[0]).toContain('/v1/convai/agents/create');
  });

  it('updates an existing agent to the latest template', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: [
            { id: 'tool_message', tool_config: { type: 'client', name: 'messageClaudeCode', description: '' } },
            { id: 'tool_permission', tool_config: { type: 'client', name: 'processPermissionRequest', description: '' } },
          ],
        }),
      )
      .mockResolvedValueOnce(okJson({ agent_id: 'agent_1' }));

    const { updateHappierElevenLabsAgent } = await import('./autoprovision');
    await updateHappierElevenLabsAgent({ apiKey: 'xi_test', agentId: 'agent_1' });

    expect(fetchMock().mock.calls[1]?.[0]).toContain('/v1/convai/agents/agent_1');
    expect(fetchMock().mock.calls[1]?.[1]?.method).toBe('PATCH');
    const body = JSON.parse(fetchMock().mock.calls[1]?.[1]?.body);
    expect(body.conversation_config.agent.prompt.tool_ids).toEqual(['tool_message', 'tool_permission']);
  });

  it('always sends xi-api-key header and does not leak it in error messages', async () => {
    fetchMock().mockResolvedValueOnce(errorResponse(401, 'bad key: xi_test'));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    let thrown: unknown = null;
    try {
      await createHappierElevenLabsAgent({ apiKey: 'xi_test' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(String((thrown as Error)?.message ?? '')).toMatch(/ElevenLabs/i);

    const headers = fetchMock().mock.calls?.[0]?.[1]?.headers as Headers;
    expect(headers.get('xi-api-key')).toBe('xi_test');
    expect(headers.get('Content-Type')).toBe('application/json');

    expect(String((thrown as Error)?.message ?? '')).not.toContain('xi_test');
  });

  it('fails without creating an agent when client tool creation partially fails', async () => {
    fetchMock()
      .mockResolvedValueOnce(okJson({ tools: [] }))
      .mockResolvedValueOnce(okJson({ id: 'tool_message' }))
      .mockResolvedValueOnce(errorResponse(500, 'tool_create_failed'));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(createHappierElevenLabsAgent({ apiKey: 'xi_test' })).rejects.toThrow(/ElevenLabs API error \(500\)/);

    const requestUrls = fetchMock().mock.calls.map((call) => String(call[0]));
    expect(requestUrls).toEqual([
      expect.stringContaining('/v1/convai/tools'),
      expect.stringContaining('/v1/convai/tools'),
      expect.stringContaining('/v1/convai/tools'),
    ]);
    expect(requestUrls.some((url) => url.includes('/v1/convai/agents/create'))).toBe(false);
  });

  it('fails when create agent response is missing agent_id', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: [
            { id: 'tool_message', tool_config: { type: 'client', name: 'messageClaudeCode' } },
            { id: 'tool_permission', tool_config: { type: 'client', name: 'processPermissionRequest' } },
          ],
        }),
      )
      .mockResolvedValueOnce(okJson({ agent_id: '' }));

    const { createHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(createHappierElevenLabsAgent({ apiKey: 'xi_test' })).rejects.toThrow(
      'ElevenLabs create agent did not return an agent_id',
    );
  });

  it('surfaces update failure with sanitized ElevenLabs error', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        okJson({
          tools: [
            { id: 'tool_message', tool_config: { type: 'client', name: 'messageClaudeCode' } },
            { id: 'tool_permission', tool_config: { type: 'client', name: 'processPermissionRequest' } },
          ],
        }),
      )
      .mockResolvedValueOnce(errorResponse(502, 'backend unavailable'));

    const { updateHappierElevenLabsAgent } = await import('./autoprovision');
    await expect(updateHappierElevenLabsAgent({ apiKey: 'xi_test', agentId: 'agent_1' })).rejects.toThrow(
      /ElevenLabs API error \(502\)/,
    );

    const patchCall = fetchMock().mock.calls[1];
    expect(String(patchCall?.[0])).toContain('/v1/convai/agents/agent_1');
    expect(patchCall?.[1]?.method).toBe('PATCH');
  });
});
