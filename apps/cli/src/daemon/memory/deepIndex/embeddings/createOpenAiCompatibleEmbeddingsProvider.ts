import { z } from 'zod';

import {
  decryptSecretValueWithKeysV1,
  type MemoryEmbeddingsOpenAiCompatibleConfig,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { withAbortTimeout } from '@/diagnostics/httpClient';

import type { EmbeddingsProvider } from './embeddingsProviderTypes';

const EmbeddingsResponseSchema = z.object({
  data: z.array(z.object({
    embedding: z.array(z.number()),
  })),
});

function buildEmbeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`;
}

function toFloat32Array(values: readonly number[]): Float32Array {
  const out = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    out[index] = Number.isFinite(values[index] ?? NaN) ? Number(values[index]) : 0;
  }
  return out;
}

export async function createOpenAiCompatibleEmbeddingsProvider(params: Readonly<{
  config: MemoryEmbeddingsOpenAiCompatibleConfig;
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>;
}>): Promise<EmbeddingsProvider> {
  const baseUrl = String(params.config.baseUrl ?? '').trim();
  if (!baseUrl) {
    throw new Error('OpenAI-compatible embeddings base URL is missing');
  }

  const apiKey = decryptSecretValueWithKeysV1(params.config.apiKey, params.settingsSecretsReadKeys)?.trim() ?? '';
  if (!apiKey) {
    throw new Error('OpenAI-compatible embeddings API key is missing');
  }

  const requestEmbeddings = async (
    input: string | readonly string[],
    expectedCount: number,
  ): Promise<Float32Array[]> => {
    const body: Record<string, unknown> = {
      input,
      model: params.config.model,
    };
    if (typeof params.config.dimensions === 'number') {
      body.dimensions = params.config.dimensions;
    }

    let response: Response;
    try {
      response = await withAbortTimeout(configuration.memoryEmbeddingsRemoteRequestTimeoutMs, async (signal) => {
        return await fetch(buildEmbeddingsUrl(baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      });
    } catch (error) {
      if (
        error instanceof DOMException
        && error.name === 'AbortError'
      ) {
        throw new Error(`Embeddings request timed out after ${configuration.memoryEmbeddingsRemoteRequestTimeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Embeddings request failed with status ${response.status}`);
    }

    const parsed = EmbeddingsResponseSchema.parse(await response.json());
    if (parsed.data.length !== expectedCount) {
      throw new Error(`Embeddings response length mismatch: expected ${expectedCount}, received ${parsed.data.length}`);
    }
    return parsed.data.map((item) => toFloat32Array(item.embedding));
  };

  return {
    providerKind: 'openai_compatible',
    modelId: params.config.model,
    embedDocuments: async (texts) => {
      const clean = texts.map((text) => String(text ?? '').trim());
      if (clean.length === 0) return [];
      return await requestEmbeddings(clean, clean.length);
    },
    embedQuery: async (text) => {
      const rows = await requestEmbeddings(String(text ?? '').trim(), 1);
      if (!rows[0]) throw new Error('No embedding produced');
      return rows[0];
    },
  };
}
