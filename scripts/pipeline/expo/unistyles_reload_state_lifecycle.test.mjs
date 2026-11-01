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

// These source contracts protect the reload/lifetime fixes when upgrading the native
// dependency. They do not replace compiling and exercising the iOS/Android runtime.
test('Unistyles retains outgoing runtime state until its own generation is invalidated', async () => {
  const registryHeader = await readUnistylesSource('cxx/core/UnistylesRegistry.h');
  const registrySource = await readUnistylesSource('cxx/core/UnistylesRegistry.cpp');
  const isCurrentBody = functionBody(registryHeader, 'inline bool isCurrent(');
  assert.match(isCurrentBody, /generation\s*!=\s*0\s*&&\s*generation\s*==\s*this->_generation\.load\(\)/);

  const takeOwnershipBody = functionBody(registrySource, 'UnistylesRegistry::takeOwnership()');
  assert.match(takeOwnershipBody, /_replacedStates\[previousGeneration\]\s*=\s*this->takeOwnedState\(\)/);
  assert.ok(
    takeOwnershipBody.indexOf('takeOwnedState()') < takeOwnershipBody.indexOf('_generation.store('),
    'outgoing JSI values must be retained before publishing the replacement generation',
  );

  const takeStateBody = functionBody(registrySource, 'UnistylesRegistry::takeOwnedState()');
  assert.match(takeStateBody, /ownedState\.state\s*=\s*std::move\(this->_state\)/);
  assert.match(takeStateBody, /ownedState\.styleSheets\s*=\s*std::exchange\(this->_styleSheetRegistry,\s*\{\}\)/);
  assert.match(takeStateBody, /ownedState\.shadowRegistry\s*=\s*std::exchange\(this->_shadowRegistry,\s*\{\}\)/);
  assert.match(takeStateBody, /ownedState\.updates\s*=\s*this->trafficController\.takeUpdates\(\)/);
  assert.match(takeStateBody, /return ownedState/);
  assert.doesNotMatch(takeStateBody, /this->_state\.reset\(|this->_styleSheetRegistry\.clear\(|this->_shadowRegistry\.clear\(/);

  const releaseBody = functionBody(registrySource, 'UnistylesRegistry::releaseOwnership(');
  const currentReleaseBody = functionBody(releaseBody, 'if (this->isCurrent(generation))');
  assert.match(currentReleaseBody, /releasedState\s*=\s*this->takeOwnedState\(\)/);
  assert.match(currentReleaseBody, /this->_generation\.store\(0\)/);
  const outgoingReleaseBody = functionBody(releaseBody, 'else if (auto it = this->_replacedStates.find(generation)');
  assert.match(outgoingReleaseBody, /releasedState\s*=\s*std::move\(it->second\)/);
  assert.match(outgoingReleaseBody, /this->_replacedStates\.erase\(it\)/);
  assert.doesNotMatch(
    outgoingReleaseBody,
    /takeOwnedState\(|_generation\.(?:store|exchange)\(|\.clear\(/,
    'delayed invalidation must release only the outgoing generation, never the current state',
  );

  const iosSource = await readUnistylesSource('ios/UnistylesModuleOnLoad.mm');
  const iosInstallBody = functionBody(iosSource, '- (void)installJSIBindingsWithRuntime');
  assert.match(iosInstallBody, /_generation\s*=\s*core::UnistylesRegistry::get\(\)\.takeOwnership\(\)/);
  const iosInvalidateBody = functionBody(iosSource, '- (void)invalidate');
  assert.match(iosInvalidateBody, /UnistylesRegistry::get\(\)\.releaseOwnership\(_generation\)/);

  const androidSource = await readUnistylesSource('android/src/main/cxx/NativeUnistylesModule.h');
  const androidInvalidateBody = functionBody(androidSource, 'static void invalidateNative');
  assert.match(androidInvalidateBody, /UnistylesRegistry::get\(\)\.releaseOwnership\(self->_generation\)/);

  const androidModuleSource = await readUnistylesSource('android/src/main/cxx/NativeUnistylesModule.cpp');
  const androidBindingsBody = functionBody(androidModuleSource, 'UnistylesModule::getBindingsInstaller');
  assert.match(androidBindingsBody, /self->_generation\s*=\s*core::UnistylesRegistry::get\(\)\.takeOwnership\(\)/);
});

test('Unistyles rejects outgoing runtime work before accessing the replacement state', async () => {
  const runtimeSource = await readUnistylesSource('cxx/hybridObjects/HybridUnistylesRuntime.cpp');
  assert.match(functionBody(runtimeSource, 'HybridUnistylesRuntime::ownsRegistry()'), /isCurrent\(this->generation\)/);
  assert.match(functionBody(runtimeSource, 'HybridUnistylesRuntime::getState()'), /if \(!this->ownsRegistry\(\)\)[\s\S]*?throw/);

  const styleSheetSource = await readUnistylesSource('cxx/hybridObjects/HybridStyleSheet.cpp');
  for (const callback of ['onPlatformDependenciesChange', 'onPlatformNativeDependenciesChange', 'onImeChange']) {
    const callbackBody = functionBody(styleSheetSource, `void HybridStyleSheet::${callback}(`);
    assert.match(callbackBody, /if \(!self \|\| !self->_unistylesRuntime->ownsRegistry\(\)\)\s*\{\s*return;/);
    assert.ok(callbackBody.indexOf('ownsRegistry()') < callbackBody.indexOf('applyDependencyChanges('));
  }

  const shadowRegistrySource = await readUnistylesSource('cxx/hybridObjects/HybridShadowRegistry.cpp');
  const scheduledUpdateBody = functionBody(shadowRegistrySource, 'void HybridShadowRegistry::scheduleShadowTreeUpdate(');
  assert.match(scheduledUpdateBody, /if \(!unistylesRuntime->ownsRegistry\(\)\)\s*\{\s*return jsi::Value::undefined\(\);/);
  assert.ok(scheduledUpdateBody.indexOf('ownsRegistry()') < scheduledUpdateBody.indexOf('ShadowTreeManager::updateShadowTree('));

  const wrapperSource = await readUnistylesSource('cxx/core/UnistyleWrapper.h');
  assert.match(wrapperSource, /unistylesRuntime->ownsRegistry\(\)\s*\?\s*registry\.getUnistyleById\(unistyleID\)\s*:\s*nullptr/);
  assert.match(wrapperSource, /if \(unistyle == nullptr\)\s*\{\s*throw jsi::JSError/);
});

test('Unistyles consumes shadow-tree updates once while pinning their native families', async () => {
  const trafficControllerHeader = await readUnistylesSource('cxx/shadowTree/ShadowTrafficController.h');
  const takeUpdatesBody = functionBody(trafficControllerHeader, 'takeUpdates()');
  assert.match(takeUpdatesBody, /return std::exchange\(_unistylesUpdates,\s*\{\}\)/);
  const setUpdateBody = functionBody(trafficControllerHeader, 'inline void setUpdate(');
  assert.match(setUpdateBody, /PinnedShadowLeafUpdate\{std::move\(family\),\s*std::move\(props\)\}/);
  const updateTypes = await readUnistylesSource('cxx/shadowTree/ShadowLeafUpdate.h');
  assert.match(functionBody(updateTypes, 'struct PinnedShadowLeafUpdate'), /std::shared_ptr<const ShadowNodeFamily>\s+family/);

  const registrySource = await readUnistylesSource('cxx/core/UnistylesRegistry.cpp');
  const unlinkBody = functionBody(registrySource, 'void core::UnistylesRegistry::unlinkShadowNodeWithUnistyles(');
  assert.match(unlinkBody, /forgetFamilyUnsafe\(shadowNodeFamily,\s*releasedFamilies\)/);
  const forgetBody = functionBody(registrySource, 'void core::UnistylesRegistry::forgetFamilyUnsafe(');
  assert.match(forgetBody, /this->_shadowRegistry\.erase\(it\)/);
  assert.match(forgetBody, /trafficController\.removeShadowNode\(shadowNodeFamily\)/);
  const queueBody = functionBody(registrySource, 'void core::UnistylesRegistry::queueShadowLeafUpdatesUnsafe(');
  assert.match(queueBody, /if \(it == this->_shadowRegistry\.end\(\)\)\s*\{\s*continue;/);
  assert.match(queueBody, /trafficController\.setUpdate\(it->second\.family,\s*std::move\(props\)\)/);

  const shadowTreeSource = await readUnistylesSource('cxx/shadowTree/ShadowTreeManager.cpp');
  const updateShadowTreeBody = functionBody(
    shadowTreeSource,
    'shadow::ShadowTreeManager::updateShadowTree(jsi::Runtime& rt)',
  );
  assert.match(updateShadowTreeBody, /trafficController\.takeUpdates\(\)/);
  assert.match(
    updateShadowTreeBody,
    /PinnedShadowLeafUpdates updates;[\s\S]*?trafficController\.withLock\(/,
    'family pins must survive the commit lock and native pointer dereferences',
  );
});
