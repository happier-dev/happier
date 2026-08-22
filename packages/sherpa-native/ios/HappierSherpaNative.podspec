require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HappierSherpaNative'
  s.version        = package['version']
  s.summary        = 'Happier Sherpa native speech module (TTS/STT)'
  s.description    = package['description'] || s.summary
  s.homepage       = 'https://happier.dev'
  s.license        = { :type => 'MIT' }
  s.authors        = { 'Happier' => 'dev@happier.dev' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/../common/cpp"'
  }

  sherpa_version = ENV['HAPPIER_SHERPA_ONNX_VERSION'] || 'v1.12.25'
  sherpa_archive = "sherpa-onnx-#{sherpa_version}-ios.tar.bz2"
  sherpa_base_url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/#{sherpa_version}"
  sherpa_vendor_dir = File.join(__dir__, 'vendor', 'sherpa-onnx', sherpa_version)
  sherpa_checksum_resolver = File.expand_path('../scripts/resolve-sherpa-checksum.mjs', __dir__)

  s.prepare_command = <<-CMD
    set -euo pipefail
    mkdir -p "#{sherpa_vendor_dir}"

    if [ ! -d "#{sherpa_vendor_dir}/build-ios/sherpa-onnx.xcframework" ]; then
      echo "[HappierSherpaNative] Downloading sherpa-onnx iOS runtime (#{sherpa_version})"
      curl -L --retry 3 --retry-delay 1 -o "#{sherpa_vendor_dir}/checksum.txt" "#{sherpa_base_url}/checksum.txt"
      curl -L --retry 3 --retry-delay 1 -o "#{sherpa_vendor_dir}/#{sherpa_archive}" "#{sherpa_base_url}/#{sherpa_archive}"

      if [ ! -f "#{sherpa_checksum_resolver}" ]; then
        echo "[HappierSherpaNative] Missing checksum resolver at #{sherpa_checksum_resolver}"
        exit 1
      fi
      expected=$(node "#{sherpa_checksum_resolver}" "#{sherpa_vendor_dir}/checksum.txt" "#{sherpa_archive}" | tr -d '\\r\\n')

      actual=$(shasum -a 256 "#{sherpa_vendor_dir}/#{sherpa_archive}" | awk '{print $1}' | tr -d '\\r\\n')
      if [ "${expected}" != "${actual}" ]; then
        echo "[HappierSherpaNative] sha256 mismatch for #{sherpa_archive}"
        echo "  expected=${expected}"
        echo "  actual=${actual}"
        exit 1
      fi

      tar -xf "#{sherpa_vendor_dir}/#{sherpa_archive}" -C "#{sherpa_vendor_dir}"
    fi
  CMD

  s.vendored_frameworks = [
    "vendor/sherpa-onnx/#{sherpa_version}/build-ios/sherpa-onnx.xcframework",
    "vendor/sherpa-onnx/#{sherpa_version}/build-ios/ios-onnxruntime/onnxruntime.xcframework"
  ]

  s.libraries = 'c++'

  s.source_files = [
    '*.{h,m,mm,swift}',
    '../common/cpp/HappierSherpaAsrStreamRegistry.h',
    '../common/cpp/HappierSherpaTtsJobRegistry.h'
  ]
  s.private_header_files = [
    '../common/cpp/HappierSherpaAsrStreamRegistry.h',
    '../common/cpp/HappierSherpaTtsJobRegistry.h'
  ]
  s.exclude_files = 'Tests/**/*'
  s.resource_bundles = {
    'HappierSherpaNativeResources' => ['../android/src/main/assets/silero_vad_v5.onnx']
  }
end
