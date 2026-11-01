import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const reactNativeDir = path.dirname(require.resolve('react-native/package.json'));
const uiDir = fileURLToPath(new URL('../..', import.meta.url));

test('React Native pod installation keeps glog namespace fragments textual for Swift C++ imports', (t) => {
    const ruby = spawnSync('ruby', ['--version'], { encoding: 'utf8' });
    if (ruby.error?.code === 'ENOENT') {
        t.skip('Ruby is required to exercise the actual React Native CocoaPods utility');
        return;
    }
    assert.equal(ruby.status, 0, ruby.stderr);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glog module map '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const glogMap = path.join(directory, 'glog.modulemap');
    const otherMap = path.join(directory, 'other.modulemap');
    const original = 'module glog {\n  umbrella header "glog-umbrella.h"\n  export *\n  module * { export * }\n}\n';
    fs.writeFileSync(glogMap, original);
    fs.writeFileSync(otherMap, 'module Other { export * }\n');
    const headers = ['logging.h', 'log_severity.h', 'vlog_is_on.h'].map((name) => path.join(directory, name));
    for (const header of headers) fs.writeFileSync(header, '// external CocoaPods header fixture\n');

    // CocoaPods is the external boundary; execute the installed RN implementation against real files.
    const script = String.raw`
require 'pathname'
require File.join(ARGV.fetch(0), 'scripts/cocoapods/utils.rb')
HeaderAccessor = Struct.new(:public_headers)
PodTarget = Struct.new(:pod_name, :module_map_path, :file_accessors)
Installer = Struct.new(:pod_targets)
directory = Pathname.new(ARGV.fetch(1))
headers = %w[logging.h log_severity.h vlog_is_on.h].map { |name| directory + name }
glog = PodTarget.new('glog', directory + 'glog.modulemap', [HeaderAccessor.new(headers)])
other = PodTarget.new('Other', directory + 'other.modulemap', [])
installer = Installer.new([glog, other])
ReactNativePodsUtils.fix_glog_module_map(installer)
first = (directory + 'glog.modulemap').read
ReactNativePodsUtils.fix_glog_module_map(installer)
raise 'repeated pod installation changed the module map' unless first == (directory + 'glog.modulemap').read
print first
`;
    const result = spawnSync('ruby', ['-e', script, reactNativeDir, directory], {
        cwd: uiDir,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /module glog \{/);
    assert.match(result.stdout, /module \* \{ export \* \}/);
    for (const header of headers.slice(1)) {
        assert.ok(result.stdout.includes(`textual header ${JSON.stringify(header)}`), result.stdout);
    }
    assert.equal(fs.readFileSync(otherMap, 'utf8'), 'module Other { export * }\n');
});
