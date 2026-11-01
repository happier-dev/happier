// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const linuxWebKitVersion = '2.54.1';
export const linuxWebKitSourceUrl = `https://webkitgtk.org/releases/webkitgtk-${linuxWebKitVersion}.tar.xz`;
export const linuxWebKitSourceSha256 = 'ea0bbb02dbdbc596874a4e7ad35b66645b3e0a232bd0e4081de5ed92eb0a397d';
const multiarch = 'usr/lib/x86_64-linux-gnu';

export function linuxWebKitAppImageFilesConfig() {
  const gpuProcess = `/${multiarch}/webkit2gtk-4.1/WebKitGPUProcess`;
  return { bundle: { linux: { appimage: { files: { [gpuProcess]: gpuProcess } } } } };
}


/** @param {string} actual @param {string} maximum */
function newerThan(actual, maximum) {
  const a = actual.split('.').map(Number);
  const b = maximum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

/** Validate the real SDK or final AppImage at its native filesystem/process boundary.
 * @param {{root:string, layout?:'sdk'|'installed'|'appimage', inspect?:typeof execFileSync}} options
 */
export function validateLinuxWebKitRuntime({ root, layout = 'sdk', inspect = execFileSync }) {
  if (!['sdk', 'installed', 'appimage'].includes(layout)) throw new Error(`Unknown WebKit runtime layout: ${layout}`);
  const actualRoot = fs.realpathSync(root);
  const libraryDir = layout === 'appimage' ? 'usr/lib' : multiarch;
  const helpers = `${multiarch}/webkit2gtk-4.1`;
  const files = [
    `${libraryDir}/libwebkit2gtk-4.1.so.0`, `${libraryDir}/libjavascriptcoregtk-4.1.so.0`,
    `${helpers}/WebKitWebProcess`, `${helpers}/WebKitNetworkProcess`, `${helpers}/WebKitGPUProcess`,
    `${helpers}/injected-bundle/libwebkit2gtkinjectedbundle.so`,
    ...(layout === 'sdk' ? [`${helpers}/MiniBrowser`, `${helpers}/jsc`, 'usr/bin/WebKitWebDriver'] : []),
  ];
  const env = { ...process.env, LD_LIBRARY_PATH: [path.join(actualRoot, libraryDir), path.join(actualRoot, multiarch), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  for (const relative of files) {
    const file = path.join(actualRoot, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Missing WebKit runtime file: ${relative}`);
    const resolved = fs.realpathSync(file);
    if (path.relative(actualRoot, resolved).startsWith(`..${path.sep}`) || path.relative(actualRoot, resolved) === '..') throw new Error(`WebKit runtime file is outside staged tree: ${relative}`);
    const linkage = String(inspect('ldd', ['-r', file], { env, encoding: 'utf8', stdio: 'pipe' }));
    if (/not found|undefined symbol/i.test(linkage)) throw new Error(`WebKit runtime has unresolved dependencies: ${relative}\n${linkage}`);
    const versions = String(inspect('readelf', ['--version-info', file], { encoding: 'utf8', stdio: 'pipe' }));
    const needs = versions.split(/Version needs section/)[1];
    if (!needs) throw new Error(`Missing ELF version requirements: ${relative}`);
    for (const match of needs.matchAll(/Name:\s+(GLIBCXX|GLIBC)_([\d.]+)/g)) {
      if (newerThan(match[2], match[1] === 'GLIBC' ? '2.35' : '3.4.30')) {
        throw new Error(`WebKit runtime requires ${match[1]}_${match[2]} beyond the Ubuntu 22.04 ABI: ${relative}`);
      }
    }
  }
  const script = 'import ctypes,sys; w=ctypes.CDLL(sys.argv[1]); print(".".join(str(getattr(w,"webkit_get_"+part+"_version")()) for part in ("major","minor","micro")))';
  const version = String(inspect('python3', ['-c', script, path.join(actualRoot, files[0])], { env, encoding: 'utf8', stdio: 'pipe' })).trim();
  if (version !== linuxWebKitVersion) throw new Error(`expected WebKitGTK ${linuxWebKitVersion}, received ${version}`);
  return { version, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { recipe: { type: 'boolean' }, root: { type: 'string' }, layout: { type: 'string', default: 'sdk' } } });
  const layout = values.layout;
  if (layout !== 'sdk' && layout !== 'installed' && layout !== 'appimage') throw new Error(`Unknown WebKit runtime layout: ${layout}`);
  if (values.recipe) console.log([linuxWebKitVersion, linuxWebKitSourceUrl, linuxWebKitSourceSha256].join('\n'));
  else if (values.root) console.log(JSON.stringify(validateLinuxWebKitRuntime({ root: values.root, layout })));
  else throw new Error('Pass --recipe or --root PATH');
}
