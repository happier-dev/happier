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
 * So this page is generated from the website download manifest rather than retyped. The alternative
 * is two hand-maintained copies of the same URLs, which is how the website ended
 * up with three dead links in the first place — the exact history its own
 * docblock records.
 *
 * Google Play is the primary Android listing; the direct APK remains available.
 * Both destinations come from the same manifest the website consumes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const MANIFEST = join(REPO, 'apps', 'website', 'src', 'data', 'downloads.json');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'getting-started', 'get-the-apps.mdx');

/** Validate and shape the shared JSON manifest for the docs renderer. */
export function parseDownloadManifest(source) {
  const manifest = JSON.parse(source);
  if (!manifest.desktopAssetBase || !Array.isArray(manifest.desktopPlatforms)) {
    throw new Error('downloads.json is missing desktop release data');
  }
  const asset = (file) => `${manifest.desktopAssetBase}/${file}`;

  return {
    desktop: manifest.desktopPlatforms.map((platform) => ({
      label: platform.sublabel ? `${platform.label} (${platform.sublabel.replace(' · .exe installer', '')})` : platform.label,
      href: asset(platform.file),
    })),
    desktopReleases: manifest.desktopReleasesPage,
    appStore: manifest.appStoreUrl,
    androidApk: manifest.androidApkUrl,
    androidPlay: manifest.androidPlayUrl,
    webApp: manifest.webAppUrl,
    installUnix: manifest.installCommandUnix,
    installWindows: manifest.installCommandWindows,
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
  <Card title="Android" href="${m.androidPlay}" description="Happier on Google Play." />
  <Card title="Android (APK)" href="${m.androidApk}" description="Direct download for installation outside Google Play." />
</Cards>

Install Happier from Google Play, or use the APK above if you prefer to install
it directly.

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

These stable links always resolve to the current release. Every immutable build
is listed on the [releases page](${m.desktopReleases}), together with checksums
and minisign signatures. Linux desktop downloads are currently x64.

### Linux AppImage prerequisites

Make the downloaded AppImage executable, then run it from your graphical desktop
session. The AppImage still needs the host's EGL and OpenGL ES libraries, and
FUSE 2 to mount itself. On Debian 13 or Ubuntu 24.04, install them with:

\`\`\`bash
sudo apt install libegl1 libgles2 libfuse2t64
chmod +x happier-ui-desktop-linux-x86_64.AppImage
./happier-ui-desktop-linux-x86_64.AppImage
\`\`\`

If startup reports missing \`libEGL.so.1\` or \`libGLESv2.so.2\`, the relevant
packages are \`libegl1\` and \`libgles2\`. Debian 12 and Ubuntu 22.04 call the
FUSE 2 library package \`libfuse2\`; keep your existing FUSE 3 installation.
See the [AppImage FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
for other distributions and systems where mounting is unavailable.

### Linux rendering and startup troubleshooting

If scrolling or animations stutter in the AppImage, try the DEB or RPM above
when your distribution supports it. The AppImage bundles WebKitGTK; native
packages use your distribution's WebKitGTK, so rendering can differ. This is a
comparison to try, not a guaranteed performance improvement. On other
distributions, the [browser client](/getting-started/get-the-apps#in-a-browser)
provides another way to use Happier.

<Callout type="warn">
Before switching package formats, send any pending messages and close Happier.
[WebKitGTK 2.52 and newer change the local IndexedDB format](https://github.com/WebKit/WebKit/commit/4905ec5f9240c6826dca52cfea2ae496fbb7b8b3).
After a newer runtime opens the desktop profile, WebKitGTK 2.50 may fail to open
its databases. Keep the newer-runtime installation available, and do not delete
app data to troubleshoot this error. Comparing with the browser client avoids
changing the desktop profile.
</Callout>

On NVIDIA with Wayland, a native package can instead exit before opening a
window with \`Error 71 (Protocol error) dispatching to Wayland display\`.
For this specific startup failure, try launching the installed app from a
terminal with \`__NV_DISABLE_EXPLICIT_SYNC=1\` set for that invocation. See
[the upstream graphics issue](https://github.com/tauri-apps/tauri/issues/10702).
This workaround does not address slow painting in the AppImage.

Homebrew is coming for macOS, but is not published yet: once the \`happier\` cask is accepted into
Homebrew, \`brew install --cask happier\` will install the same notarized DMG. The app keeps
updating itself either way, so a plain \`brew upgrade\` leaves it alone; \`brew upgrade --greedy\`
also upgrades it.

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
[CLI](/apps/cli) for the other install routes (a [Homebrew formula](/apps/cli#homebrew-coming-soon)
is prepared but not published yet), release channels, and what to do when the
command is not found afterwards.

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
