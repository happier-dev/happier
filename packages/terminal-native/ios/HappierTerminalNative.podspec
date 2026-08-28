require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
renderer_policy = JSON.parse(File.read(File.join(__dir__, '..', 'native-renderers.json')))
ghostty_framework_path = File.join(__dir__, 'Vendor', 'GhosttyKit.xcframework')
build_identity_path = File.join(__dir__, 'Resources', 'happier-terminal-native-build-identity.json')
read_bool_env = lambda do |name|
  value = ENV.fetch(name, '').strip.downcase
  ['1', 'true', 'yes', 'on'].include?(value)
end
ghostty_package_proof_accepted = read_bool_env.call('HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED')
ghostty_crash_fallback_proven = read_bool_env.call('HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN')
app_environment = ENV.fetch('APP_ENV', '').strip.downcase
engineering_qa_allowed_app_environments = renderer_policy
  .fetch('engineeringQa')
  .fetch('allowedAppEnvironments')
qa_crash_injection_enabled = read_bool_env.call('HAPPIER_TERMINAL_NATIVE_QA_CRASH_INJECTION') &&
  engineering_qa_allowed_app_environments.include?(app_environment)
ghostty_framework_link_allowed = File.exist?(ghostty_framework_path) && ghostty_package_proof_accepted && ghostty_crash_fallback_proven
pod_target_xcconfig = {
  'DEFINES_MODULE' => 'YES'
}
swift_flags = ['$(inherited)']

if ghostty_package_proof_accepted
  swift_flags << '-DHAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED'
end

if ghostty_crash_fallback_proven
  swift_flags << '-DHAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN'
end

if qa_crash_injection_enabled
  swift_flags << '-DHAPPIER_TERMINAL_NATIVE_QA_CRASH_INJECTION'
end

Pod::Spec.new do |s|
  s.name           = 'HappierTerminalNative'
  s.version        = package['version']
  s.summary        = 'Happier optional native terminal renderer module'
  s.description    = package['description'] || s.summary
  s.homepage       = 'https://happier.dev'
  s.license        = { :type => 'MIT' }
  s.authors        = { 'Happier' => 'dev@happier.dev' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.{h,m,mm,swift}'
  s.resources = 'Resources/happier-terminal-native-build-identity.json' if File.exist?(build_identity_path)

  if ghostty_framework_link_allowed
    s.vendored_frameworks = 'Vendor/GhosttyKit.xcframework'
    s.libraries = 'c++'
    s.script_phase = {
      :name => 'Isolate Ghostty Wuffs symbols',
      :script => '/bin/bash "${PODS_TARGET_SRCROOT}/namespaceGhosttyWuffs.sh" "${PODS_XCFRAMEWORKS_BUILD_DIR}/HappierTerminalNative/libghostty.a" && touch "${DERIVED_FILE_DIR}/happier-terminal-native-wuffs-isolated"',
      :input_files => ['${PODS_XCFRAMEWORKS_BUILD_DIR}/HappierTerminalNative/libghostty.a'],
      :output_files => ['${DERIVED_FILE_DIR}/happier-terminal-native-wuffs-isolated'],
      :execution_position => :after_compile
    }
    swift_flags << '-DHAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY'
    if read_bool_env.call('HAPPIER_TERMINAL_NATIVE_IOS_ACCESSIBILITY_NATIVE')
      swift_flags << '-DHAPPIER_TERMINAL_NATIVE_IOS_ACCESSIBILITY_NATIVE'
    end
  end

  pod_target_xcconfig['OTHER_SWIFT_FLAGS'] = swift_flags.join(' ')
  s.pod_target_xcconfig = pod_target_xcconfig
end
