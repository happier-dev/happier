import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const uiRequire = createRequire(path.join(repoRoot, 'apps/ui/package.json'));
const unistylesRoot = path.dirname(uiRequire.resolve('react-native-unistyles/package.json'));

async function readUnistylesSource(relativePath) {
  return await readFile(path.join(unistylesRoot, relativePath), 'utf8');
}

function functionBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Missing native function: ${signature}`);

  const bodyStart = source.indexOf('{', signatureIndex);
  assert.notEqual(bodyStart, -1, `Missing body for native function: ${signature}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }

  assert.fail(`Unterminated body for native function: ${signature}`);
}

test('Unistyles reload lifecycle isolates native state by JSI runtime', async () => {
  const registryHeader = await readUnistylesSource('cxx/core/UnistylesRegistry.h');
  assert.match(
    registryHeader,
    /std::unordered_map<jsi::Runtime\*, UnistylesState>\s+_states/,
    'JSI-owned state must be keyed by the runtime that created it',
  );
  assert.match(
    registryHeader,
    /std::unordered_map<jsi::Runtime\*, std::unordered_map<int, std::shared_ptr<core::StyleSheet>>>\s+_styleSheetRegistry/,
    'stylesheets must not be shared across JSI runtimes',
  );
  assert.match(
    registryHeader,
    /std::unordered_map<jsi::Runtime\*, std::unordered_map<const ShadowNodeFamily\*, std::vector<std::shared_ptr<UnistyleData>>>>\s+_shadowRegistry/,
    'shadow-node registrations must not be shared across JSI runtimes',
  );
  assert.match(
    registryHeader,
    /std::unordered_map<jsi::Runtime\*, std::unordered_set<const ShadowNodeFamily\*>>\s+_suspendedFamilies/,
    'suspended shadow-node families must not be shared across JSI runtimes',
  );
  assert.match(
    registryHeader,
    /std::unordered_map<jsi::Runtime\*, std::unique_ptr<shadow::ShadowTrafficController>>\s+_trafficControllers/,
    'pending shadow-tree updates must not be shared across JSI runtimes',
  );
  assert.match(
    registryHeader,
    /std::unordered_map<jsi::Runtime\*, std::optional<std::string>>\s+_scopedThemes/,
    'scoped themes must not be shared across JSI runtimes',
  );
  assert.match(
    registryHeader,
    /std::unordered_map<jsi::Runtime\*, bool>\s+_shouldUsePointsForBreakpoints/,
    'breakpoint unit settings must not be shared across JSI runtimes',
  );

  const registrySource = await readUnistylesSource('cxx/core/UnistylesRegistry.cpp');
  const createStateBody = functionBody(registrySource, 'void core::UnistylesRegistry::createState(jsi::Runtime& rt)');
  assert.match(createStateBody, /this->_states\.try_emplace\(&rt\)/, 'createState must add state keyed by the current runtime');
  assert.doesNotMatch(
    createStateBody,
    /_states\.clear\(\)|destroy\(\)/,
    'configuring a new runtime must not destroy JSI values owned by an older runtime',
  );

  const destroyStateBody = functionBody(registrySource, 'void core::UnistylesRegistry::destroyState(jsi::Runtime* rt)');
  for (const runtimeOwnedRegistry of [
    '_states',
    '_styleSheetRegistry',
    '_shadowRegistry',
    '_suspendedFamilies',
    '_trafficControllers',
    '_scopedThemes',
    '_shouldUsePointsForBreakpoints',
  ]) {
    assert.match(
      destroyStateBody,
      new RegExp(`this->${runtimeOwnedRegistry}\\.erase\\(rt\\)`),
      `destroyState must clear only the invalidated runtime's ${runtimeOwnedRegistry}`,
    );
  }
  assert.doesNotMatch(
    destroyStateBody,
    /\.clear\(\)/,
    'delayed invalidation must never clear registries owned by a newer runtime',
  );

  const iosSource = await readUnistylesSource('ios/UnistylesModuleOnLoad.mm');
  assert.match(iosSource, /@implementation UnistylesModule\s*\{\s*jsi::Runtime\* _runtime;/);
  const iosInstallBody = functionBody(iosSource, '- (void)installJSIBindingsWithRuntime');
  assert.match(iosInstallBody, /_runtime = &rt;/, 'iOS must remember which runtime this module instance owns');
  assert.doesNotMatch(
    iosInstallBody,
    /UnistylesRegistry::get\(\)\.(?:destroy|destroyState)\(/,
    'installing iOS bindings must not destroy JSI values from a runtime that may still be alive',
  );

  const iosInvalidateBody = functionBody(iosSource, '- (void)invalidate');
  assert.match(iosInvalidateBody, /UnistylesRegistry::get\(\)\.destroyState\(_runtime\)/);
  assert.match(iosInvalidateBody, /_runtime = nullptr;/);

  const androidSource = await readUnistylesSource('android/src/main/cxx/NativeUnistylesModule.h');
  assert.match(androidSource, /jsi::Runtime\* _runtime = nullptr;/);
  const androidInvalidateBody = functionBody(androidSource, 'static void invalidateNative');
  assert.match(androidInvalidateBody, /UnistylesRegistry::get\(\)\.destroyState\(self->_runtime\)/);
  assert.match(androidInvalidateBody, /self->_runtime = nullptr;/);

  const androidModuleSource = await readUnistylesSource('android/src/main/cxx/NativeUnistylesModule.cpp');
  const androidBindingsBody = functionBody(androidModuleSource, 'UnistylesModule::getBindingsInstaller');
  assert.match(androidBindingsBody, /self->_runtime = &rt;/, 'Android must remember which runtime this module instance owns');
  assert.doesNotMatch(
    androidBindingsBody,
    /UnistylesRegistry::get\(\)\.(?:destroy|destroyState)\(/,
    'installing Android bindings must not destroy JSI values from a runtime that may still be alive',
  );
});
