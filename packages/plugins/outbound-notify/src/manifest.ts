import { definePlugin } from '@happier-dev/plugin-sdk';
import { senders } from './send.js';

export const outboundNotifyPlugin = definePlugin({
  id: 'happier.outbound-notify', version: '0.0.0', displayName: 'Outbound notifications',
  description: 'Send notifications to ntfy, Teams Workflows, Mattermost, Gotify and Pushover.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [], optional: [] },
  settings: {
    'ntfy-settings': { version: 1, title: 'ntfy', target: { kind: 'plugin' }, scope: 'account', fields: [
      { id: 'ntfy-url', title: 'Server URL', description: 'Root URL of the ntfy server, such as https://ntfy.sh/.', schema: { type: 'string' } },
      { id: 'ntfy-topic', title: 'Topic', schema: { type: 'string' } },
      { id: 'ntfy-token', title: 'Access token', description: 'Optional for public topics. Link a Saved Secret for a protected topic.', schema: { type: 'string' }, secret: true },
    ] },
    'teams-settings': { version: 1, title: 'Teams Workflows', target: { kind: 'plugin' }, scope: 'account', fields: [
      { id: 'teams-url', title: 'Workflow webhook URL', description: 'Use a Teams Workflow with the When a Teams webhook request is received trigger and Anyone authentication. Link its URL as a Saved Secret.', schema: { type: 'string' }, secret: true },
    ] },
    'mattermost-settings': { version: 1, title: 'Mattermost', target: { kind: 'plugin' }, scope: 'account', fields: [
      { id: 'mattermost-url', title: 'Incoming webhook URL', description: 'Create an Incoming Webhook in Mattermost Integrations and link its URL as a Saved Secret.', schema: { type: 'string' }, secret: true },
    ] },
    'gotify-settings': { version: 1, title: 'Gotify', target: { kind: 'plugin' }, scope: 'account', fields: [
      { id: 'gotify-url', title: 'Server URL', description: 'Base URL of your Gotify server.', schema: { type: 'string' } },
      { id: 'gotify-token', title: 'Application token', description: 'Link a Gotify application token as a Saved Secret.', schema: { type: 'string' }, secret: true },
    ] },
    'pushover-settings': { version: 1, title: 'Pushover', target: { kind: 'plugin' }, scope: 'account', fields: [
      { id: 'pushover-token', title: 'Application token', schema: { type: 'string' }, secret: true },
      { id: 'pushover-user', title: 'User or group key', schema: { type: 'string' }, secret: true },
    ] },
  },
  notificationChannels: {
    ntfy: { declaration: { title: 'ntfy', kind: 'plugin' }, sender: senders.ntfy },
    teams: { declaration: { title: 'Teams Workflows', kind: 'plugin' }, sender: senders.teams },
    mattermost: { declaration: { title: 'Mattermost', kind: 'plugin' }, sender: senders.mattermost },
    gotify: { declaration: { title: 'Gotify', kind: 'plugin' }, sender: senders.gotify },
    pushover: { declaration: { title: 'Pushover', kind: 'plugin' }, sender: senders.pushover },
  },
});
export const { manifest: PLUGIN_MANIFEST, activate } = outboundNotifyPlugin;
export const manifest = PLUGIN_MANIFEST;
