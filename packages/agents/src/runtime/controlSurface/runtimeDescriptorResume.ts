import {
  readCanonicalRuntimeDescriptorV1ForAgent,
} from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import {
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';

import type { AgentId } from '../../types.js';
import { isAbsolutePathLike } from '../../path/isAbsolutePathLike.js';
import type { ProviderSessionControlAdapter } from './types.js';

export type RuntimeDescriptorResumeIdSessionControlContribution = Readonly<{
  providerId: AgentId;
  absolutePathField?: string;
  legacyAbsolutePathField?: string;
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

function readAbsolutePath(record: Record<string, unknown> | null, field: string | undefined): string | null {
  if (!record || !field) return null;
  const value = readTrimmedString(record[field]);
  return value && isAbsolutePathLike(value) ? value : null;
}

export function createRuntimeDescriptorResumeIdSessionControlAdapter(
  contribution: RuntimeDescriptorResumeIdSessionControlContribution,
): ProviderSessionControlAdapter {
  return Object.freeze({
    resolveVendorResumeId(metadata: unknown): string | null {
      const metadataRecord = asRecord(metadata);
      if (!metadataRecord) return null;

      const descriptor = readCanonicalRuntimeDescriptorV1ForAgent(
        readRuntimeDescriptorV1FromMetadata(metadataRecord),
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
    resolveSessionArtifactPath(metadata: unknown): string | null {
      const metadataRecord = asRecord(metadata);
      if (!metadataRecord) return null;

      const descriptor = readCanonicalRuntimeDescriptorV1ForAgent(
        readRuntimeDescriptorV1FromMetadata(metadataRecord),
        contribution.providerId,
      );
      const descriptorRecord = asRecord(descriptor);
      if (descriptorRecord) {
        return readAbsolutePath(descriptorRecord, contribution.absolutePathField)
          ?? readAbsolutePath(metadataRecord, contribution.legacyAbsolutePathField);
      }

      if (
        Object.hasOwn(metadataRecord, 'runtimeDescriptorV1')
        || Object.hasOwn(metadataRecord, 'agentRuntimeDescriptorV1')
      ) {
        return null;
      }

      return readAbsolutePath(metadataRecord, contribution.legacyAbsolutePathField);
    },
  });
}
