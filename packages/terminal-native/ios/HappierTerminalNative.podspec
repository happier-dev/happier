require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
ghostty_framework_path = File.join(__dir__, 'Vendor', 'GhosttyKit.xcframework')
read_bool_env = lambda do |name|
  value = ENV.fetch(name, '').strip.downcase
  ['1', 'true', 'yes', 'on'].include?(value)
end
ghostty_package_proof_accepted = read_bool_env.call('HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED')
ghostty_crash_fallback_proven = read_bool_env.call('HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN')
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

  if ghostty_framework_link_allowed
    s.vendored_frameworks = 'Vendor/GhosttyKit.xcframework'
    s.libraries = 'c++'
    swift_flags << '-DHAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY'
    if read_bool_env.call('HAPPIER_TERMINAL_NATIVE_IOS_ACCESSIBILITY_NATIVE')
      swift_flags << '-DHAPPIER_TERMINAL_NATIVE_IOS_ACCESSIBILITY_NATIVE'
    end
  end

  pod_target_xcconfig['OTHER_SWIFT_FLAGS'] = swift_flags.join(' ')
  s.pod_target_xcconfig = pod_target_xcconfig
end
