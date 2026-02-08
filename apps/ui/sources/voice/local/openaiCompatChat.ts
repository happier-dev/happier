import { normalizeOpenAiCompatibleBaseUrl } from './openaiCompat';

export type OpenAiCompatChatMessage = Readonly<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;

export function buildOpenAiChatCompletionRequest(opts: Readonly<{
  baseUrl: string;
  apiKey: string | null;
  model: string;
  messages: ReadonlyArray<OpenAiCompatChatMessage>;
  temperature: number;
  maxTokens: number | null;
}>): { url: string; init: RequestInit } {
  const baseV1 = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  if (!baseV1) throw new Error('Invalid base URL');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = (opts.apiKey ?? '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body: any = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
  };
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;

  return {
    url: `${baseV1}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  };
}

export async function parseOpenAiChatCompletionAssistantText(res: Response): Promise<string> {
  const json: any = await res.json().catch(() => null);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  return '';
}

