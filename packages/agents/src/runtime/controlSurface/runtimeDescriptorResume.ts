import {
  readCanonicalRuntimeDescriptorV1ForProvider,
  readRawRuntimeDescriptorV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import type { AgentId } from '../../types.js';
import { isAbsolutePathLike } from '../../path/isAbsolutePathLike.js';
import type { ProviderSessionControlAdapter } from './types.js';

export type RuntimeDescriptorResumeIdSessionControlContribution = Readonly<{
  providerId: AgentId;
  absolutePathField?: string;
  fallbackField: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function createRuntimeDescriptorResumeIdSessionControlAdapter(
  contribution: RuntimeDescriptorResumeIdSessionControlContribution,
): ProviderSessionControlAdapter {
  return Object.freeze({
    resolveVendorResumeId(metadata: unknown): string | null {
      const metadataRecord = asRecord(metadata);
      if (!metadataRecord) return null;

      const descriptor = readCanonicalRuntimeDescriptorV1ForProvider(
        readRuntimeDescriptorV1FromMetadata(metadataRecord) ?? readRawRuntimeDescriptorV1FromMetadata(metadataRecord),
        contribution.providerId,
      );
      const descriptorRecord = asRecord(descriptor);
      if (!descriptorRecord) return null;

      const absoluteValue = contribution.absolutePathField
        ? readTrimmedString(descriptorRecord[contribution.absolutePathField])
        : null;
      if (absoluteValue && isAbsolutePathLike(absoluteValue)) {
        return absoluteValue;
      }

      return readTrimmedString(descriptorRecord[contribution.fallbackField]);
    },
  });
}
