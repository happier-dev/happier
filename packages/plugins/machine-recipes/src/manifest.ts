import { definePlugin, DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/plugin-sdk';
import { binfmtQemu } from './binfmtQemu.js';
import { installPackage } from './installPackage.js';
import { googleChrome } from './googleChrome.js';
import { browserBot } from './browserBot.js';
import { BACKUP_RECEIVER_RECIPE } from './backupReceiver.js';
import { JOURNAL_READER_RECIPE } from './journalReader.js';
import { dockerEngine } from './dockerEngine.js';
import { coolify } from './coolify.js';
import { dokploy } from './dokploy.js';
import { caddy } from './caddy.js';
import { coder } from './coder.js';
import { firewall } from './firewall.js';
import { automaticSecurityUpdates } from './automaticSecurityUpdates.js';
import { sshHardening } from './sshHardening.js';
import { sshFail2ban } from './sshFail2ban.js';
import { auditLogging } from './auditLogging.js';
import { boundedJournal } from './boundedJournal.js';
import { tailscaleServer } from './tailscaleServer.js';
import { securityPresets } from './securityPresets.js';

/** Cold recipe declarations; native support and effects remain host-owned. */
export const MACHINE_RECIPES_PLUGIN = definePlugin({
  id: DOCKER_ENGINE_RECIPE_REF_V1.pluginId,
  version: '0.0.0',
  displayName: 'Machine recipes',
  description: 'Declarative software choices for machine setup.',
  machineRecipes: {
    'automatic-security-updates': automaticSecurityUpdates,
    'ssh-hardening': sshHardening,
    'ssh-fail2ban': sshFail2ban,
    'audit-logging': auditLogging,
    'bounded-journal': boundedJournal,
    'tailscale-server': tailscaleServer,
    [DOCKER_ENGINE_RECIPE_REF_V1.recipeId]: dockerEngine,
    coolify,
    dokploy,
    caddy,
    coder,
    firewall,
    'binfmt-qemu': binfmtQemu,
    'backup-receiver': BACKUP_RECEIVER_RECIPE,
    'journal-reader': JOURNAL_READER_RECIPE,
    'install-package': installPackage,
    'google-chrome': googleChrome,
    fonts: {
      revision: '1',
      title: 'Fonts',
      icon: 'file',
      description: 'Fonts so screenshots and rendered pages read properly.',
      software: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
      removeSteps: [{ id: 'fonts', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'fonts-dejavu-core' }] }],
    },
    ffmpeg: {
      revision: '1',
      title: 'FFmpeg',
      icon: 'asset',
      description: 'Record, convert and cut audio and video.',
      software: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'ffmpeg', kind: 'package', manager: 'apt', packages: [{ name: 'ffmpeg' }] }],
      removeSteps: [{ id: 'ffmpeg', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'ffmpeg' }] }],
    },
    'virtual-display': {
      revision: '1',
      title: 'Virtual display',
      icon: 'desktop',
      description: 'A desktop for bots that need a screen. It starts only when one asks for it.',
      software: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'display-packages', kind: 'package', manager: 'apt', packages: [
        { name: 'xvfb' }, { name: 'openbox' }, { name: 'at-spi2-core' }, { name: 'dbus' }, { name: 'libglib2.0-bin' },
      ] }],
      removeSteps: [{ id: 'display-packages', kind: 'package', manager: 'apt', state: 'absent', packages: [
        { name: 'xvfb' }, { name: 'openbox' }, { name: 'at-spi2-core' }, { name: 'dbus' }, { name: 'libglib2.0-bin' },
      ] }],
    },
  },
  machineSetupPresets: { 'browser-bot-v1': browserBot, ...securityPresets },
});

export const PLUGIN_MANIFEST = MACHINE_RECIPES_PLUGIN.manifest;
export const manifest = PLUGIN_MANIFEST;
