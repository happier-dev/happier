/**
 * Renders the "Get the apps" page from the website's download manifest.
 *
 * Nothing on the documentation site told a reader where to get the app. Zero
 * hits for `apps.apple.com`, zero for the APK, zero for the desktop build — on
 * a 125-page site whose first section is called Getting started. Meanwhile
 * `apps/website/src/data/downloads.ts` already held every URL, was already the
 * single source of truth for the marketing site, and already had a link checker
 * (`yarn --cwd apps/website check:links`) HEADing all of them before deploy.
 *
 * So this page is generated from that file rather than retyped. The alternative
 * is two hand-maintained copies of the same URLs, which is how the website ended
 * up with three dead links in the first place — the exact history its own
 * docblock records.
 *
 * The Android situation is deliberately not smoothed over. There is no public
 * Play listing; `ANDROID_PLAY_URL` 404s for everyone, and the manifest says in
 * as many words not to ship it. The APK is what Android users actually use, so
 * that is what this page leads with.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const MANIFEST = join(REPO, 'apps', 'website', 'src', 'data', 'downloads.ts');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'getting-started', 'get-the-apps.mdx');

/** Pull the exported string constants out of the manifest. */
export function parseDownloadManifest(source) {
  const read = (name) => {
    const match = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*\n?\\s*'([^']+)'`).exec(source);
    if (!match) throw new Error(`downloads.ts is missing ${name}`);
    return match[1];
  };
  const version = read('DESKTOP_VERSION');
  const base = /const DESKTOP_ASSET_BASE\s*=\s*\n?\s*'([^']+)'/.exec(source);
  if (!base) throw new Error('downloads.ts is missing DESKTOP_ASSET_BASE');
  const asset = (file) => `${base[1]}/${file}`;

  return {
    desktopVersion: version,
    desktop: [
      { label: 'macOS (Apple Silicon)', href: asset(`happier-ui-desktop-darwin-aarch64-v${version}.dmg`) },
      { label: 'macOS (Intel)', href: asset(`happier-ui-desktop-darwin-x86_64-v${version}.dmg`) },
      { label: 'Windows (x64)', href: asset(`happier-ui-desktop-windows-x86_64-v${version}.exe`) },
      { label: 'Linux (x64, AppImage)', href: asset(`happier-ui-desktop-linux-x86_64-v${version}.AppImage`) },
    ],
    desktopReleases: read('DESKTOP_RELEASES_PAGE'),
    appStore: read('APP_STORE_URL'),
    androidApk: read('ANDROID_APK_URL'),
    androidOptIn: read('ANDROID_PLAY_TESTING_OPT_IN_URL'),
    webApp: read('WEB_APP_URL'),
    installUnix: read('INSTALL_COMMAND_UNIX'),
    installWindows: read('INSTALL_COMMAND_WINDOWS'),
  };
}

export async function renderDownloadsPageMarkdown({ manifestPath = MANIFEST } = {}) {
  const m = parseDownloadManifest(readFileSync(manifestPath, 'utf8'));
  const desktopRows = m.desktop.map((d) => `| ${d.label} | [Download](${d.href}) |`).join('\n');

  return `---
title: Get the apps
description: Where to download Happier for iPhone, Android, desktop and the browser, and which one to start with.
---

Happier runs your coding agents on a computer you control and gives you a way to
drive them from somewhere else. So you need two things: the CLI on the machine
that will do the work, and a client to drive it from.

Start with the client. You cannot finish the CLI's login without one — the
terminal prints a code for a browser or phone you are already signed in on.

## On your phone

<Cards>
  <Card title="iPhone and iPad" href="${m.appStore}" description="Happier on the App Store." />
  <Card title="Android (APK)" href="${m.androidApk}" description="Direct download. There is no public Play listing yet." />
</Cards>

Android is worth a sentence of explanation. There is no public Google Play
listing today — the Play track is closed testing, so the store page returns
"not found" unless your Google account is already on the tester list. The APK
above is a direct download and is how most Android users are running Happier.
If you would rather go through Play, you can [join the testing
programme](${m.androidOptIn}) first; the store page starts working for your
account once you have.

## In a browser

[${m.webApp.replace(/^https?:\/\//, '').replace(/\/$/, '')}](${m.webApp}) is the
full client — no install, and the fastest way to see whether Happier suits you.
It is also the easiest place to complete the CLI login, because you are probably
already signed in to a browser on the machine you are setting up.

## On your desktop

The desktop app adds things a browser tab cannot do: it can install and manage
the background service for you, and it keeps a window and tray presence when the
session is running somewhere else.

| Platform | Download |
| --- | --- |
${desktopRows}

Current desktop build: **v${m.desktopVersion}**. Every build is listed on the
[releases page](${m.desktopReleases}) if you need an older one or a different
architecture. The desktop app is versioned separately from the CLI, so its
number will not match \`happier --version\`.

## On the machine that runs your agents

This is the part that does the work, and it is a CLI rather than an app:

\`\`\`bash
${m.installUnix}
\`\`\`

On Windows, in PowerShell:

\`\`\`powershell
${m.installWindows}
\`\`\`

The installer verifies every release signature before unpacking. See
[CLI](/clients/cli) for the other install routes, release channels, and what to
do when the command is not found afterwards.

## Related

- [Onboarding](/getting-started/onboarding) — connecting the two halves.
- [Check your setup](/getting-started/check-your-setup) — confirming it worked.
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderDownloadsPageMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
