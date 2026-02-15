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
    'DEFINES_MODULE' => 'YES'
  }

  sherpa_version = ENV['HAPPIER_SHERPA_ONNX_VERSION'] || 'v1.12.25'
  sherpa_archive = "sherpa-onnx-#{sherpa_version}-ios.tar.bz2"
  sherpa_base_url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/#{sherpa_version}"
  sherpa_vendor_dir = File.join(__dir__, 'vendor', 'sherpa-onnx', sherpa_version)

  s.prepare_command = <<-CMD
    set -euo pipefail
    mkdir -p "#{sherpa_vendor_dir}"

    if [ ! -d "#{sherpa_vendor_dir}/build-ios/sherpa-onnx.xcframework" ]; then
      echo "[HappierSherpaNative] Downloading sherpa-onnx iOS runtime (#{sherpa_version})"
      curl -L --retry 3 --retry-delay 1 -o "#{sherpa_vendor_dir}/checksum.txt" "#{sherpa_base_url}/checksum.txt"
      curl -L --retry 3 --retry-delay 1 -o "#{sherpa_vendor_dir}/#{sherpa_archive}" "#{sherpa_base_url}/#{sherpa_archive}"

      expected=$(grep " #{sherpa_archive}$" "#{sherpa_vendor_dir}/checksum.txt" | awk '{print $1}' | tr -d '\\r\\n')
      if [ -z "${expected}" ]; then
        echo "[HappierSherpaNative] Failed to locate sha256 for #{sherpa_archive} in checksum.txt"
        exit 1
      fi

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

  s.source_files = '**/*.{h,m,mm,swift}'
end
