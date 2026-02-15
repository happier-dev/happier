cmake_minimum_required(VERSION 3.22.1)

project(happier_sherpa_native)

set(CMAKE_CXX_STANDARD 17)

add_library(happier_sherpa_jni SHARED
  HappierSherpaNativeJni.cpp
)

target_include_directories(happier_sherpa_jni PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(NOT DEFINED SHERPA_EXTRACT_DIR)
  message(FATAL_ERROR "SHERPA_EXTRACT_DIR is not set")
endif()

set(SHERPA_JNILIBS_DIR "${SHERPA_EXTRACT_DIR}/jniLibs")

add_library(sherpa_onnx_c_api SHARED IMPORTED)
set_target_properties(sherpa_onnx_c_api PROPERTIES
  IMPORTED_LOCATION "${SHERPA_JNILIBS_DIR}/${ANDROID_ABI}/libsherpa-onnx-c-api.so"
)

find_library(log-lib log)

target_link_libraries(happier_sherpa_jni
  sherpa_onnx_c_api
  ${log-lib}
)
