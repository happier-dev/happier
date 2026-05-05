cmake_minimum_required(VERSION 3.13)

project(happiercryptoworker)

set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 17)

set(LIBSODIUM_ROOT "${NODE_MODULES_DIR}/@more-tech/react-native-libsodium/libsodium/build")

if (${ANDROID_ABI} STREQUAL arm64-v8a)
  set(LIBSODIUM_BUILD_DIR "${LIBSODIUM_ROOT}/libsodium-android-armv8-a+crypto")
elseif(${ANDROID_ABI} STREQUAL armeabi-v7a)
  set(LIBSODIUM_BUILD_DIR "${LIBSODIUM_ROOT}/libsodium-android-armv7-a")
elseif(${ANDROID_ABI} STREQUAL x86)
  set(LIBSODIUM_BUILD_DIR "${LIBSODIUM_ROOT}/libsodium-android-i686")
else()
  set(LIBSODIUM_BUILD_DIR "${LIBSODIUM_ROOT}/libsodium-android-westmere")
endif()

add_library(sodium SHARED IMPORTED)
set_target_properties(sodium PROPERTIES IMPORTED_LOCATION "${LIBSODIUM_BUILD_DIR}/lib/libsodium.so")

add_library(happiercryptoworker SHARED happier_crypto_worker.cpp)

target_include_directories(happiercryptoworker PRIVATE "${LIBSODIUM_BUILD_DIR}/include")
target_link_options(happiercryptoworker PRIVATE "-Wl,-z,max-page-size=16384")
target_link_libraries(happiercryptoworker sodium log)
