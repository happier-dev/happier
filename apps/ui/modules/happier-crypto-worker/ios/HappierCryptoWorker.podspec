require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HappierCryptoWorker'
  s.version        = package['version']
  s.summary        = 'Happier native crypto batch worker'
  s.description    = package['description'] || s.summary
  s.homepage       = 'https://happier.dev'
  s.license        = { :type => 'MIT' }
  s.authors        = { 'Happier' => 'dev@happier.dev' }
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true
  s.libraries = 'z'

  s.dependency 'ExpoModulesCore'
  s.dependency 'react-native-libsodium'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = [
    'HappierCryptoWorker.swift',
    'HappierCryptoWorkerAesGcm.swift',
    'HappierCryptoWorkerBase64.swift',
    'HappierCryptoWorkerDataKeyEnvelope.swift',
    'HappierCryptoWorkerModule.swift',
    'HappierCryptoWorkerPassword.swift',
    'HappierCryptoWorkerSecretbox.swift',
    'HappierCryptoWorkerSessionCrypto.swift',
    'HappierCryptoWorkerSha256.swift',
    'HappierCryptoWorkerTypes.swift',
  ]
end
