import axios from 'axios';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginAvailabilityActionHttpPathsV1,
  PluginAvailabilityMaterializationsReportActionInputV1Schema,
  PluginAvailabilityMaterializationsReportActionOutputV1Schema,
  PluginAvailabilityReleasePublishActionInputV1Schema,
  PluginAvailabilityReleasePublishActionOutputV1Schema,
  type PluginAvailabilityMaterializationsReportActionInputV1,
  type PluginAvailabilityMaterializationsReportActionOutputV1,
  type PluginAvailabilityReleasePublishActionInputV1,
  type PluginAvailabilityReleasePublishActionOutputV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAxiosResponseErrorCode } from '@/api/client/readAxiosResponseErrorCode';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const RELEASE_PUBLISH_PATH = PluginAvailabilityActionHttpPathsV1[
  'account.plugins.availability.release.publish'
];
const MATERIALIZATIONS_REPORT_PATH = PluginAvailabilityActionHttpPathsV1[
  'account.plugins.availability.materializations.report'
];

export class PluginAvailabilityReleaseContentConflictError extends Error {
  readonly code = 'plugin_release_content_conflict' as const;

  constructor() {
    super('plugin_release_content_conflict');
    this.name = 'PluginAvailabilityReleaseContentConflictError';
  }
}

/** The Availability transport is the only adapter that turns this HTTP conflict into a typed daemon outcome. */
export function isPluginAvailabilityReleaseContentConflictError(
  error: unknown,
): error is PluginAvailabilityReleaseContentConflictError {
  return error instanceof PluginAvailabilityReleaseContentConflictError;
}

export type PluginAvailabilityPublisher = Readonly<{
  publishRelease(
    input: PluginAvailabilityReleasePublishActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginAvailabilityReleasePublishActionOutputV1>;
  reportMaterializations(
    input: PluginAvailabilityMaterializationsReportActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginAvailabilityMaterializationsReportActionOutputV1>;
}>;

async function postPublisherAction(params: Readonly<{
  credentials: StoredCredentials;
  path: string;
  body: unknown;
  signal?: AbortSignal;
}>): Promise<unknown> {
  const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
    method: 'POST',
    path: params.path,
    body: params.body,
  });
  params.signal?.throwIfAborted();
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}${params.path}`,
    params.body,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.credentials.token}`,
        ...(publisherHeader
          ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader }
          : {}),
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: (status) => status >= 200 && status < 300,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  return response.data;
}

/**
 * The daemon's sole authenticated Availability producer transport. It signs
 * the exact normalized body and uses the Protocol-owned action paths; callers
 * retain install-registry ownership of release facts and snapshot currentness.
 */
export function createServerPluginAvailabilityPublisher(params: Readonly<{
  credentials: StoredCredentials;
}>): PluginAvailabilityPublisher {
  return Object.freeze({
    async publishRelease(rawInput, options = {}) {
      const input = PluginAvailabilityReleasePublishActionInputV1Schema.parse(rawInput);
      try {
        const response = await postPublisherAction({
          credentials: params.credentials,
          path: RELEASE_PUBLISH_PATH,
          body: input,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return PluginAvailabilityReleasePublishActionOutputV1Schema.parse(response);
      } catch (error) {
        if (
          axios.isAxiosError(error)
          && error.response?.status === 409
          && readAxiosResponseErrorCode(error) === 'plugin_release_content_conflict'
        ) {
          throw new PluginAvailabilityReleaseContentConflictError();
        }
        throw error;
      }
    },
    async reportMaterializations(rawInput, options = {}) {
      const input = PluginAvailabilityMaterializationsReportActionInputV1Schema.parse(rawInput);
      const response = await postPublisherAction({
        credentials: params.credentials,
        path: MATERIALIZATIONS_REPORT_PATH,
        body: input,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return PluginAvailabilityMaterializationsReportActionOutputV1Schema.parse(response);
    },
  });
}
