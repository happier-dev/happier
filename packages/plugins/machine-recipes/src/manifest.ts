import { definePlugin } from '@happier-dev/plugin-sdk';
import { binfmtQemu } from './binfmtQemu.js';
import { installPackage } from './installPackage.js';
import { googleChrome } from './googleChrome.js';
import { browserBot } from './browserBot.js';
import { BACKUP_RECEIVER_RECIPE } from './backupReceiver.js';
import { JOURNAL_READER_RECIPE } from './journalReader.js';

/** Cold recipe declarations; native support and effects remain host-owned. */
export const MACHINE_RECIPES_PLUGIN = definePlugin({
  id: 'happier.machine.recipes',
  version: '0.0.0',
  displayName: 'Machine recipes',
  description: 'Declarative software choices for machine setup.',
  machineRecipes: {
    'binfmt-qemu': binfmtQemu,
    'backup-receiver': BACKUP_RECEIVER_RECIPE,
    'journal-reader': JOURNAL_READER_RECIPE,
    'install-package': installPackage,
    'google-chrome': googleChrome,
    fonts: {
      revision: '1',
      title: 'Fonts',
      icon: 'file',
      description: 'DejaVu fonts for tools running on this Machine.',
      software: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
      removeSteps: [{ id: 'fonts', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'fonts-dejavu-core' }] }],
    },
    ffmpeg: {
      revision: '1',
      title: 'FFmpeg',
      icon: 'asset',
      description: 'Media tools for software running on this Machine.',
      software: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'ffmpeg', kind: 'package', manager: 'apt', packages: [{ name: 'ffmpeg' }] }],
      removeSteps: [{ id: 'ffmpeg', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'ffmpeg' }] }],
    },
    'virtual-display': {
      revision: '1',
      title: 'Virtual display',
      icon: 'desktop',
      description: 'Xvfb, Openbox and accessibility support for an on-demand bot desktop managed by the Happier daemon.',
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
  machineSetupPresets: { 'browser-bot-v1': browserBot },
});

export const PLUGIN_MANIFEST = MACHINE_RECIPES_PLUGIN.manifest;
export const manifest = PLUGIN_MANIFEST;
