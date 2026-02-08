import agentTemplate from './agentTemplate.v1.json';
import { elevenLabsFetchJson } from './elevenLabsApi';

type ElevenLabsTool = {
  id: string;
  tool_config?: {
    type?: string;
    name?: string;
    description?: string;
  };
};

const REQUIRED_CLIENT_TOOLS: Array<{ name: string; description: string }> = [
  {
    name: 'messageClaudeCode',
    description: 'Send a message to Claude Code in the active Happier session.',
  },
  {
    name: 'processPermissionRequest',
    description: 'Approve/deny the current permission request. Call with {"decision":"allow"} or {"decision":"deny"}.',
  },
];

async function listTools(apiKey: string): Promise<ElevenLabsTool[]> {
  const json = await elevenLabsFetchJson({ apiKey, path: '/convai/tools', init: { method: 'GET' } });
  const tools = (json as any)?.tools;
  return Array.isArray(tools) ? (tools as ElevenLabsTool[]) : [];
}

async function createClientTool(apiKey: string, spec: { name: string; description: string }): Promise<string> {
  const json = await elevenLabsFetchJson({
    apiKey,
    path: '/convai/tools',
    init: {
      method: 'POST',
      body: JSON.stringify({
        tool_config: {
          type: 'client',
          name: spec.name,
          description: spec.description,
        },
      }),
    },
  });
  const id = (json as any)?.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('ElevenLabs create tool did not return an id');
  }
  return id;
}

async function ensureClientToolIds(apiKey: string): Promise<string[]> {
  const tools = await listTools(apiKey);

  const ids: string[] = [];
  for (const required of REQUIRED_CLIENT_TOOLS) {
    const existing = tools.find((t) => t.tool_config?.type === 'client' && t.tool_config?.name === required.name);
    if (existing?.id) {
      ids.push(existing.id);
      continue;
    }
    const created = await createClientTool(apiKey, required);
    ids.push(created);
  }
  return ids;
}

export async function createHappierElevenLabsAgent({ apiKey }: { apiKey: string }): Promise<{ agentId: string }> {
  const toolIds = await ensureClientToolIds(apiKey);

  const json = await elevenLabsFetchJson({
    apiKey,
    path: '/convai/agents/create',
    init: {
      method: 'POST',
      body: JSON.stringify({
        name: (agentTemplate as any).name,
        conversation_config: {
          agent: {
            prompt: {
              prompt: (agentTemplate as any).prompt,
              tool_ids: toolIds,
            },
          },
        },
      }),
    },
  });

  const agentId = (json as any)?.agent_id;
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error('ElevenLabs create agent did not return an agent_id');
  }
  return { agentId };
}

export async function updateHappierElevenLabsAgent({
  apiKey,
  agentId,
}: {
  apiKey: string;
  agentId: string;
}): Promise<void> {
  const toolIds = await ensureClientToolIds(apiKey);

  await elevenLabsFetchJson({
    apiKey,
    path: `/convai/agents/${encodeURIComponent(agentId)}`,
    init: {
      method: 'PATCH',
      body: JSON.stringify({
        conversation_config: {
          agent: {
            prompt: {
              prompt: (agentTemplate as any).prompt,
              tool_ids: toolIds,
            },
          },
        },
      }),
    },
  });
}
