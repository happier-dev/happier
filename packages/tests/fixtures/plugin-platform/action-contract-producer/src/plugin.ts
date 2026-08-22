import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

export type PublishInput = Readonly<{ title: string }>;
export type PublishResult = Readonly<{ accepted: boolean; title: string }>;
export type ArchiveInput = Readonly<{ id: string }>;
export type ArchiveResult = Readonly<{ archived: boolean; id: string }>;

const booleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);
const inputSchema = defineProtocolObject({
  title: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const resultSchema = defineProtocolObject({
  accepted: booleanSchema,
  title: defineProtocolString(),
}, { policy: 'closed' });
const archiveInputSchema = defineProtocolObject({
  id: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const archiveResultSchema = defineProtocolObject({
  archived: booleanSchema,
  id: defineProtocolString(),
}, { policy: 'closed' });

const plugin = definePlugin({
  id: 'fixture.action-contract-producer',
  version: '1.0.0',
  displayName: 'Action contract producer fixture',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/plugin.js' },
  actions: {
    publish: {
      title: 'Publish',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema,
      resultSchema,
      run: async (input) => ({ accepted: input.title.length > 0, title: input.title }),
    },
    archive: {
      title: 'Archive',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema: archiveInputSchema,
      resultSchema: archiveResultSchema,
      run: async (input) => ({ archived: input.id.length > 0, id: input.id }),
    },
  },
});

export type ProducerActionContracts = typeof plugin.actionContracts;
export const { manifest, activate } = plugin;
export const actionContracts: ProducerActionContracts = plugin.actionContracts;
