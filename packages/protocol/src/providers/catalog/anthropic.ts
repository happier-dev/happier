import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import type { ProviderCatalogProbeModelV1 } from './merge.js';
import {
  PROVIDER_REASONING_EFFORT_LEVELS_V1,
  buildProviderReasoningModelOptions,
  type ProviderReasoningEffortLevelV1,
} from './reasoningEffort.js';

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider catalog response must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Provider catalog response is missing ${key}`);
  }
  return descriptor.value;
}

function boundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function optionalOwnString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new TypeError(`Provider model ${key} must be a string`);
  }
  return descriptor.value;
}

function requiredOwnString(value: unknown, key: string): string {
  const output = optionalOwnString(value, key);
  if (output === undefined) throw new TypeError(`Provider model is missing ${key}`);
  return output;
}

function optionalOwnObject(value: unknown, key: string, label: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'object' || descriptor.value === null || Array.isArray(descriptor.value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return descriptor.value as Record<string, unknown>;
}

function requiredOwnBoolean(value: unknown, key: string, label: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'boolean') {
    throw new TypeError(`${label} ${key} must be a boolean`);
  }
  return descriptor.value;
}

function optionalOwnContextWindowTokens(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'max_input_tokens');
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('Provider model max_input_tokens must be a positive bounded integer');
  }
  try {
    return ProviderModelDescriptorV1Schema.shape.contextWindowTokens.parse(descriptor.value);
  } catch {
    throw new TypeError('Provider model max_input_tokens must be a positive bounded integer');
  }
}

function readAnthropicEffortCapability(value: unknown): Readonly<{
  supported: boolean;
  levels: readonly ProviderReasoningEffortLevelV1[];
}> | undefined {
  const capabilities = optionalOwnObject(value, 'capabilities', 'Anthropic model capabilities');
  if (!capabilities) return undefined;
  const effort = optionalOwnObject(capabilities, 'effort', 'Anthropic model effort capability');
  if (!effort) return undefined;
  const supported = requiredOwnBoolean(effort, 'supported', 'Anthropic model effort capability');
  const levels: ProviderReasoningEffortLevelV1[] = [];
  for (const level of PROVIDER_REASONING_EFFORT_LEVELS_V1) {
    const tier = optionalOwnObject(effort, level, `Anthropic model effort tier ${level}`);
    if (tier && requiredOwnBoolean(tier, 'supported', `Anthropic model effort tier ${level}`)) {
      levels.push(level);
    }
  }
  if (!supported && levels.length > 0) {
    throw new TypeError('Anthropic model effort capability cannot disable supported tiers');
  }
  if (supported && levels.length === 0) {
    throw new TypeError('Anthropic model effort capability requires a supported tier');
  }
  return { supported, levels };
}

export function parseAnthropicModelCatalog(input: unknown): Readonly<{ models: readonly ProviderCatalogProbeModelV1[]; loadStates: readonly [] }> {
  const rows = boundedArray(ownDataProperty(input, 'data'), 'Anthropic model list');
  return {
    models: rows.map((row) => {
      const id = requiredOwnString(row, 'id');
      const name = optionalOwnString(row, 'display_name');
      const contextWindowTokens = optionalOwnContextWindowTokens(row);
      const effort = readAnthropicEffortCapability(row);
      const modelOptions = effort?.supported
        ? buildProviderReasoningModelOptions({ supportedLevels: effort.levels })
        : [];
      return {
        id,
        ...(name === undefined ? {} : { name }),
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        ...(effort ? {
          capabilities: {
            reasoningControls: effort.supported ? 'supported' as const : 'unsupported' as const,
          },
        } : {}),
        ...(modelOptions.length > 0 ? { modelOptions } : {}),
      };
    }),
    loadStates: [],
  };
}

